import fs from "fs";
import _traverse from "@babel/traverse";
const traverse = (_traverse.default ?? _traverse) as typeof _traverse.default;
import parser from "@babel/parser";
import { Chunks } from "../../utility/interfaces.js";
import { printMsg, MSG } from "../../utility/printMsg.js";

/**
 * Checks if a node is a fetch identifier.
 *
 * @param node - The AST node to check
 * @returns True if the node is an identifier named 'fetch'
 */
const isFetchIdentifier = (node: any): boolean => {
    return node.type === "Identifier" && node.name === "fetch";
};

/**
 * Checks if a node represents a fallback pattern that resolves to fetch.
 *
 * Detects patterns like 'x ?? fetch' or 'cond ? x : fetch' where fetch is used as a fallback.
 *
 * @param node - The AST node to check
 * @returns True if the node is a fallback pattern that resolves to fetch
 */
const isFetchFallback = (node: any): boolean => {
    // x ?? fetch      OR     cond ? x : fetch
    return (
        (node.type === "LogicalExpression" && node.right && isFetchIdentifier(node.right)) ||
        (node.type === "ConditionalExpression" && isFetchIdentifier(node.alternate))
    );
};

/**
 * Analyzes code chunks to identify fetch API usage including direct calls and aliases.
 *
 * This function performs a multi-pass analysis to:
 * 1. Find variables that are aliases for the fetch function
 * 2. Track all direct fetch() calls
 * 3. Report call sites for both direct calls and aliases
 * 4. Mark chunks that contain fetch usage
 *
 * @param chunks - Collection of code chunks to analyze
 * @param output - Base filename for output files (without extension)
 * @param formats - Array of output formats to generate (e.g., ['json'])
 * @returns Promise that resolves to updated chunks with fetch detection results
 */
const getFetchInstances = async (chunks: Chunks, output: string, formats: string[]): Promise<Chunks> => {
    printMsg(MSG.Header, "[i] Running 'getFetchInstances' module");
    const chunk_copy: Chunks = { ...chunks };

    //   iterate through the chunks, and check fetch instances
    for (const chunk of Object.values(chunks)) {
        let chunkAst;
        try {
            chunkAst = parser.parse(chunk.code, {
                sourceType: "module",
                plugins: ["jsx", "typescript"],
                errorRecovery: true,
            });
        } catch {
            continue;
        }
        const fetchAliases = new Set();
        const fetchCalls = new Set();
        traverse(chunkAst, {
            // -------- Pass 1:  look for aliases --------
            //  a)  const S = fetch;
            //  b)  const S = something ?? fetch;
            //  c)  const S = cond ? x : fetch;
            VariableDeclarator(path) {
                const { id, init } = path.node;
                if (id.type !== "Identifier" || !init) return;

                const aliasName = id.name;
                if (isFetchIdentifier(init) || isFetchFallback(init)) {
                    // Record the binding *object* so we can track its references later
                    const binding = path.scope.getBinding(aliasName);
                    if (binding) {
                        fetchAliases.add(binding);
                    }
                }
            },
            AssignmentExpression(path) {
                // Handles re-assignment:   S = fetch;
                const { left, right } = path.node;
                if (left.type !== "Identifier") return;

                if (isFetchIdentifier(right) || isFetchFallback(right)) {
                    const binding = path.scope.getBinding(left.name);
                    if (binding) {
                        fetchAliases.add(binding);
                    }
                }
            },
            CallExpression(path) {
                if (isFetchIdentifier(path.node.callee)) {
                    const { line, column } = path.node.callee.loc.start;
                    fetchCalls.add({
                        line,
                        column,
                    });
                }
            },
        });

        // -------- Pass 2:  report the call-sites (aliases) --------
        for (const binding of fetchAliases) {
            // @ts-expect-error -- Babel's Binding type doesn't expose referencePaths in this @babel/traverse version
            binding.referencePaths.forEach((ref) => {
                const parent = ref.parent;
                if (parent.type === "CallExpression" && parent.callee === ref.node) {
                    const { line, column } = ref.node.loc.start;
                    printMsg(
                        MSG.Info,
                        `[fetch] Webpack ID ${chunk.id}: fetch() alias '${ref.node.name}' called at ${line}:${column}`
                    );
                }
            });
        }

        // -------- Pass 3:  report the call-sites (direct) --------
        for (const call of fetchCalls) {
            printMsg(
                MSG.Info,
                // @ts-expect-error -- Babel's Binding type doesn't expose referencePaths in this @babel/traverse version
                `[fetch] Webpack ID ${chunk.id}: fetch() called at ${call.line}:${call.column}`
            );
        }

        // if the length of either of the sets is non-zero, then mark the chunk as containing fetch
        if (fetchAliases.size > 0 || fetchCalls.size > 0) {
            chunk_copy[chunk.id].containsFetch = true;
        }
    }

    if (formats.includes("json")) {
        const chunks_json = JSON.stringify(chunks, null, 2);
        fs.writeFileSync(`${output}.json`, chunks_json);
        printMsg(MSG.Run, `[✓] Saved webpack with fetch instances to ${output}.json`);
    }

    return chunk_copy;
};

export default getFetchInstances;
