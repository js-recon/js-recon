import makeRequest from "../../utility/makeReq.js";
import parser from "@babel/parser";
import _traverse from "@babel/traverse";
import chalk from "chalk";
import t from "@babel/types";
import { runWithConcurrency } from "../../utility/concurrency.js";

const traverse = (_traverse.default ?? _traverse) as typeof _traverse.default;

/**
 * Pure parser: given the text content of a JS file and the URL it was fetched
 * from, returns absolute chunk URLs found inside a `__vite__mapDeps` declaration.
 *
 * Vite emits:
 *   const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["./common.X.js",...])))=>...
 */
export const extractViteMapDepsChunks = (content: string, jsUrl: string): string[] => {
    const found: string[] = [];
    let ast: any;
    try {
        ast = parser.parse(content, {
            sourceType: "unambiguous",
            plugins: ["jsx", "typescript"],
            errorRecovery: true,
        });
    } catch {
        return found;
    }

    const jsOrigin = new URL(jsUrl).origin + "/";

    traverse(ast, {
        VariableDeclarator(nodePath) {
            if (!t.isIdentifier(nodePath.node.id, { name: "__vite__mapDeps" })) return;

            const init = nodePath.node.init;
            if (!init || !t.isArrowFunctionExpression(init)) return;

            for (const param of init.params) {
                if (!t.isAssignmentPattern(param)) continue;

                const right = param.right;
                if (!t.isLogicalExpression(right) || right.operator !== "||") continue;

                const rhsOfOr = right.right;
                if (!t.isAssignmentExpression(rhsOfOr)) continue;
                if (!t.isArrayExpression(rhsOfOr.right)) continue;

                for (const element of rhsOfOr.right.elements) {
                    if (!element || !t.isStringLiteral(element)) continue;
                    const val = element.value;
                    if (!val.endsWith(".js")) continue;
                    // Explicit relative paths (./ or ../) → file-relative.
                    // Everything else → root-relative (origin).
                    const isFileRelative = val.startsWith("./") || val.startsWith("../");
                    found.push(new URL(val, isFileRelative ? jsUrl : jsOrigin).href);
                }
            }
        },
    });

    return found;
};

/**
 * Scans fetched JS files for Vite's __vite__mapDeps chunk manifest and returns
 * all the discovered chunk URLs resolved against the JS file they were found in.
 */
const vue_viteMapDeps = async (jsFiles: string[], maxJsSizeMb: number = 2, threads: number = 1): Promise<string[]> => {
    const MAX_JS_SIZE_BYTES = maxJsSizeMb * 1024 * 1024;
    const discovered = new Set<string>();

    const jsUrls = jsFiles.filter((f) => f.endsWith(".js"));

    await runWithConcurrency(jsUrls, threads, async (jsUrl) => {
        const req = await makeRequest(jsUrl);
        if (!req) return;

        const content = await req.text();
        if (content.length > MAX_JS_SIZE_BYTES) return;

        const chunks = extractViteMapDepsChunks(content, jsUrl);
        if (chunks.length > 0) {
            console.log(chalk.green(`[✓] Found ${chunks.length} chunks from __vite__mapDeps in ${jsUrl}`));
            for (const u of chunks) discovered.add(u);
        }
    });

    return [...discovered];
};

export default vue_viteMapDeps;
