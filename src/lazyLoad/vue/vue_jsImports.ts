import makeRequest from "../../utility/makeReq.js";
import parser from "@babel/parser";
import _traverse from "@babel/traverse";
import chalk from "chalk";
import { runWithConcurrency } from "../../utility/concurrency.js";

const traverse = (_traverse.default ?? _traverse) as typeof _traverse.default;

const parseJsFile = async (url: string, maxJsSizeMb: number) => {
    const MAX_JS_SIZE_BYTES = maxJsSizeMb * 1024 * 1024;
    const foundUrls = new Set<string>();
    const req = await makeRequest(url);
    if (req == null) {
        console.error(chalk.red(`Failed to fetch ${url}`));
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

    // get all the import statements
    traverse(ast, {
        ImportDeclaration(path) {
            const source = path.node.source.value;

            if (source.startsWith("./") || source.startsWith("../") || source.startsWith("/")) {
                foundUrls.add(new URL(source, url).href);
            } else {
                console.error(chalk.red(`Found import statement but can't resolve it: ${source} - on ${url}`));
            }
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
