import makeRequest from "../../utility/makeReq.js";
import parser from "@babel/parser";
import _traverse from "@babel/traverse";
import { printMsg, MSG } from "../../utility/printMsg.js";

const traverse = (_traverse.default ?? _traverse) as typeof _traverse.default;

const parseJsFile = async (url: string, maxJsSizeMb: number) => {
    const MAX_JS_SIZE_BYTES = maxJsSizeMb * 1024 * 1024;
    const foundUrls = new Set<string>();
    const req = await makeRequest(url);
    if (req == null) {
        printMsg(MSG.Err, `Failed to fetch ${url}`);
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
                printMsg(MSG.Err, `Found import statement but can't resolve it: ${source} - on ${url}`);
            }
        },
    });

    return foundUrls;
};

const vue_jsImports = async (url: string, foundJsFiles: string[], maxJsSizeMb: number = 2) => {
    const allDiscoveredUrls = new Set<string>();
    const crawledUrls = new Set<string>(foundJsFiles);

    for (const jsfile of foundJsFiles) {
        const discovered = await parseJsFile(jsfile, maxJsSizeMb);
        for (const u of discovered) allDiscoveredUrls.add(u);
    }

    // crawl newly found URLs until no uncrawled ones remain
    let foundNew = true;
    while (foundNew) {
        foundNew = false;
        for (const u of [...allDiscoveredUrls]) {
            if (!crawledUrls.has(u)) {
                foundNew = true;
                crawledUrls.add(u);
                const discovered = await parseJsFile(u, maxJsSizeMb);
                for (const newU of discovered) allDiscoveredUrls.add(newU);
            }
        }
    }

    return [...allDiscoveredUrls];
};

export default vue_jsImports;
