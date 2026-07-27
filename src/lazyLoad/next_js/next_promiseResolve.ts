import chalk from "chalk";
import makeRequest from "../../utility/makeReq.js";
import parser from "@babel/parser";
import _traverse from "@babel/traverse";
import resolvePath from "../../utility/resolvePath.js";
import { addCrawledUrl } from "../globals.js";
import { runWithConcurrency } from "../../utility/concurrency.js";
const traverse = (_traverse.default ?? _traverse) as typeof _traverse.default;

/**
 * Pure parser: scans `jsContent` for `Promise.all([...].map(...))` patterns and
 * returns the resolved chunk URLs using `jsDirBase` as the prefix.
 */
export const extractPromiseAllChunkPaths = (jsContent: string, jsDirBase: string): string[] => {
    const result: string[] = [];
    try {
        const ast = parser.parse(jsContent, {
            sourceType: "unambiguous",
            plugins: ["jsx", "typescript"],
            errorRecovery: true,
        });

        const matches: string[] = [];
        traverse(ast, {
            CallExpression(path) {
                const { node } = path;
                if (
                    node.callee.type === "MemberExpression" &&
                    node.callee.object.type === "Identifier" &&
                    node.callee.object.name === "Promise" &&
                    node.callee.property.type === "Identifier" &&
                    node.callee.property.name === "all"
                ) {
                    const arg = node.arguments[0];
                    if (
                        arg &&
                        arg.type === "CallExpression" &&
                        arg.callee.type === "MemberExpression" &&
                        arg.callee.property.type === "Identifier" &&
                        arg.callee.property.name === "map" &&
                        arg.callee.object.type === "ArrayExpression"
                    ) {
                        arg.callee.object.elements.forEach((element) => {
                            if (element && element.type === "StringLiteral") {
                                matches.push(element.value);
                            }
                        });
                    }
                }
            },
        });

        for (const match of matches) {
            const jsFileName = match.replace("static/chunks/", "/");
            result.push(jsDirBase + jsFileName);
        }
    } catch {
        // malformed content — return empty
    }
    return result;
};

const next_promiseResolveWorker = async (url: string, jsDirBase: string): Promise<string[]> => {
    const req = await makeRequest(url);
    if (!req || !req.ok) return [];
    const data = await req.text();
    return extractPromiseAllChunkPaths(data, jsDirBase);
};

const next_promiseResolve = async (urls: string[], threads: number = 1) => {
    console.log(chalk.cyan("[i] Check for Promise.all pattern"));

    let toReturn: string[] = [];

    // go through all the URLs, and find which which one has `static/chunks/` in it
    let jsDirBase: string | null = null;
    for (const url of urls) {
        if (url.includes("static/chunks/")) {
            jsDirBase = url.split("/").slice(0, -1).join("/");
            break;
        }
    }

    await runWithConcurrency(urls, threads, async (url) => {
        const result = await next_promiseResolveWorker(url, jsDirBase!);
        toReturn.push(...result);
        // add the URL to the crawled URL
        addCrawledUrl(url);
    });

    return toReturn;
};

export default next_promiseResolve;
