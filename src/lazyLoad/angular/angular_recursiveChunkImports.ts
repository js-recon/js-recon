import makeRequest from "../../utility/makeReq.js";
import _traverse from "@babel/traverse";
import * as parser from "@babel/parser";
import chalk from "chalk";
import resolvePath from "../../utility/resolvePath.js";
import { runWithConcurrency } from "../../utility/concurrency.js";

const traverse = (_traverse.default ?? _traverse) as typeof _traverse.default;

/**
 * Parses JS source and extracts every chunk import path it references, both
 * dynamic (`import("./chunk-HASH.js")`) and static (`import { a as X } from "./chunk-HASH.js"`).
 * Angular's router table uses the former; chunk-to-chunk references commonly use the latter.
 *
 * @param code The JS source to parse.
 * @returns Raw (unresolved) import path strings found in the source.
 */
export const extractImportPaths = (code: string): string[] => {
    let ast;
    try {
        ast = parser.parse(code, {
            sourceType: "unambiguous",
            plugins: ["jsx", "typescript"],
            errorRecovery: true,
        });
    } catch {
        return [];
    }

    const importPaths: string[] = [];

    traverse(ast, {
        CallExpression(path) {
            if (path.node.callee.type === "Import") {
                const importArg = path.node.arguments[0];
                if (importArg && importArg.type === "StringLiteral") {
                    importPaths.push(importArg.value);
                }
            }
        },
        ImportDeclaration(path) {
            importPaths.push(path.node.source.value);
        },
    });

    return importPaths;
};

/**
 * Given a set of already-discovered Angular chunk URLs, recursively follows their
 * import graph (both dynamic `import()` and static `import ... from`) until no new
 * chunks are discovered, guarding against cycles/duplicates via a visited set.
 *
 * @param seedUrls Chunk URLs already discovered (e.g. from angular_getFromMainJs).
 * @param threads Concurrency for each round of fetches.
 * @returns The full set of transitively-discovered chunk URLs (seed URLs excluded).
 */
const angular_recursiveChunkImports = async (seedUrls: string[], threads: number = 1): Promise<string[]> => {
    const visited = new Set<string>(seedUrls);
    const discovered = new Set<string>();

    let toCrawl = [...seedUrls];

    while (toCrawl.length > 0) {
        const roundDiscovered = new Set<string>();

        await runWithConcurrency(toCrawl, threads, async (url) => {
            let res;
            try {
                res = await makeRequest(url, {});
            } catch {
                console.error(chalk.red(`[!] Failed to fetch chunk for import resolution: ${url}`));
                return;
            }
            if (!res) return;

            const body = await res.text();
            const importPaths = extractImportPaths(body);

            for (const importPath of importPaths) {
                let resolvedUrl: string;
                try {
                    resolvedUrl = resolvePath(url, importPath);
                } catch {
                    continue;
                }
                if (!visited.has(resolvedUrl)) {
                    roundDiscovered.add(resolvedUrl);
                }
            }
        });

        toCrawl = [...roundDiscovered];
        for (const url of toCrawl) {
            visited.add(url);
            discovered.add(url);
        }
    }

    return [...discovered];
};

export default angular_recursiveChunkImports;
