import makeRequest from "../../utility/makeReq.js";
import parser from "@babel/parser";
import _traverse from "@babel/traverse";
import chalk from "chalk";
import { runWithConcurrency } from "../../utility/concurrency.js";
import { progressError } from "../../utility/progressLog.js";

const traverse = (_traverse.default ?? _traverse) as typeof _traverse.default;

const parseJsFile = async (url: string, maxJsSizeMb: number) => {
    const MAX_JS_SIZE_BYTES = maxJsSizeMb * 1024 * 1024;
    const foundUrls = new Set<string>();
    const req = await makeRequest(url);
    if (req == null) {
        progressError(chalk.red(`Failed to fetch ${url}`));
        return foundUrls;
    }
    const reqText = await req.text();

    if (reqText.length > MAX_JS_SIZE_BYTES) {
        return foundUrls;
    }

    let ast;
    try {
        ast = parser.parse(reqText, {
            sourceType: "module",
            plugins: ["importAssertions"],
        });
    } catch {
        return foundUrls;
    }

    // get all the import statements — both static `import ... from "..."` declarations and
    // dynamic `import("...")` calls. Vite's dev server serves route-based lazy-loading as
    // literal dynamic import() calls with a string argument (e.g. a Vue Router route's
    // `component: () => import("/src/views/HomeView.vue")`) rather than compiling them into
    // a chunk-manifest reference the way a production build does — without following these,
    // every dynamically-imported route/component is missed entirely.
    const addImportSource = (source: string) => {
        if (source.startsWith("./") || source.startsWith("../") || source.startsWith("/")) {
            foundUrls.add(new URL(source, url).href);
        } else {
            progressError(chalk.red(`Found import statement but can't resolve it: ${source} - on ${url}`));
        }
    };
    traverse(ast, {
        ImportDeclaration(path) {
            addImportSource(path.node.source.value);
        },
        CallExpression(path) {
            if (path.node.callee.type !== "Import") return;
            const arg = path.node.arguments[0];
            if (arg?.type === "StringLiteral") addImportSource(arg.value);
        },
    });

    return foundUrls;
};

const vue_jsImports = async (url: string, foundJsFiles: string[], maxJsSizeMb: number = 2, threads: number = 1) => {
    const allDiscoveredUrls = new Set<string>();
    const crawledUrls = new Set<string>(foundJsFiles);

    await runWithConcurrency(foundJsFiles, threads, async (jsfile) => {
        const discovered = await parseJsFile(jsfile, maxJsSizeMb);
        for (const u of discovered) allDiscoveredUrls.add(u);
    });

    // crawl newly found URLs until no uncrawled ones remain, one round of
    // concurrent fetches at a time
    let toCrawl = [...allDiscoveredUrls].filter((u) => !crawledUrls.has(u));
    while (toCrawl.length > 0) {
        for (const u of toCrawl) crawledUrls.add(u);
        await runWithConcurrency(toCrawl, threads, async (u) => {
            const discovered = await parseJsFile(u, maxJsSizeMb);
            for (const newU of discovered) allDiscoveredUrls.add(newU);
        });
        toCrawl = [...allDiscoveredUrls].filter((u) => !crawledUrls.has(u));
    }

    return [...allDiscoveredUrls];
};

export default vue_jsImports;
