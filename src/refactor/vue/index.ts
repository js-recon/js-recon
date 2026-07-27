import parser from "@babel/parser";
import _traverse from "@babel/traverse";
import { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import { Chunk } from "../../utility/interfaces.js";
import { WebpackModuleEntry, transformWebpackModule } from "../next/transform.js";
import { validateAndFix } from "../next/validator.js";
import { printMsg, MSG } from "../../utility/printMsg.js";

const traverse = (_traverse.default ?? _traverse) as typeof _traverse.default;

/**
 * Extracts the numeric module map from a webpack chunk container.
 *
 * Handles both webpack 4 (webpackJsonp) and webpack 5 (webpackChunk) formats:
 *
 *   webpack 4: (window.webpackJsonp = window.webpackJsonp || []).push([[chunkIds], {moduleId: fn, ...}])
 *   webpack 5: (self.webpackChunk_APP = self.webpackChunk_APP || []).push([[chunkIds], {moduleId: fn, ...}, runtimeFn])
 *
 * Returns an array of { id, fnNode } pairs for all module functions in the chunk,
 * or an empty array if the container format is not recognised.
 */
function extractModulesFromWebpackChunk(
    ast: t.File
): Array<{ id: string; fnNode: t.FunctionExpression | t.ArrowFunctionExpression; path: NodePath }> {
    const results: Array<{ id: string; fnNode: t.FunctionExpression | t.ArrowFunctionExpression; path: NodePath }> = [];

    traverse(ast, {
        CallExpression(callPath) {
            const node = callPath.node;
            const callee = node.callee;
            // Must be a member expression ending in `.push`
            if (!t.isMemberExpression(callee) || callee.computed) return;
            if (!t.isIdentifier(callee.property, { name: "push" })) return;
            if (node.arguments.length < 1) return;

            // The single argument is an array: [[chunkIds], {moduleMap}, ?runtimeFn]
            const arg = node.arguments[0];
            if (!t.isArrayExpression(arg)) return;
            if ((arg as t.ArrayExpression).elements.length < 2) return;

            const moduleMapNode = (arg as t.ArrayExpression).elements[1];
            if (!moduleMapNode || !t.isObjectExpression(moduleMapNode)) return;

            // Confirm the object contains at least one numeric or string key
            const props = (moduleMapNode as t.ObjectExpression).properties;
            const hasModuleProps = props.some(
                (p) =>
                    t.isObjectProperty(p) &&
                    (t.isNumericLiteral((p as t.ObjectProperty).key) || t.isStringLiteral((p as t.ObjectProperty).key))
            );
            if (!hasModuleProps) return;

            // Extract all module functions
            for (const prop of props) {
                if (!t.isObjectProperty(prop)) continue;
                const key = (prop as t.ObjectProperty).key;
                const val = (prop as t.ObjectProperty).value;

                const moduleId = t.isNumericLiteral(key)
                    ? String((key as t.NumericLiteral).value)
                    : t.isStringLiteral(key)
                      ? (key as t.StringLiteral).value
                      : null;
                if (!moduleId) continue;

                if (!t.isFunctionExpression(val) && !t.isArrowFunctionExpression(val)) continue;
                results.push({
                    id: moduleId,
                    fnNode: val as t.FunctionExpression | t.ArrowFunctionExpression,
                    path: callPath,
                });
            }

            callPath.stop();
        },
    });

    return results;
}

/**
 * Refactors a Vue webpack chunk into per-module ES module files.
 *
 * Input: a Chunk whose `code` field is a full webpack chunk file:
 *   - Possibly starts with `// File Source: <url>\n` (js-recon annotation)
 *   - Then the webpackJsonp / webpackChunk push expression
 *
 * Each module in the chunk's module map becomes a separate output file `<id>.js`.
 *
 * Module function format (webpack 4, FunctionExpression):
 *   { 429: function(module, exports, require) { ... } }
 * Module function format (webpack 5, ArrowFunctionExpression):
 *   { 429: (module, exports, require) => { ... } }
 *
 * Both formats use identical param semantics:
 *   params[0] = module    — module object (e.exports = X for CJS exports)
 *   params[1] = exports   — exports target (ODP, require.d for named exports)
 *   params[2] = require   — require function (r(N) for cross-module imports)
 */
export const refactorVueWebpack = async (chunk: Chunk): Promise<Record<string, string>> => {
    // Strip the js-recon file-source annotation if present
    const code = chunk.code.replace(/^\/\/ File Source:[^\n]*\n/, "");

    if (!code.trim()) return {};

    let ast: t.File;
    try {
        ast = parser.parse(code, {
            sourceType: "unambiguous",
            plugins: ["jsx", "typescript"],
            errorRecovery: true,
        });
    } catch {
        printMsg(MSG.Warn, `[!] Failed to parse Vue webpack chunk ${chunk.id} — skipping`);
        return {};
    }

    const modules = extractModulesFromWebpackChunk(ast);
    if (modules.length === 0) {
        printMsg(MSG.Warn, `[~] No webpack module map found in chunk ${chunk.id} — skipping`);
        return {};
    }

    // Re-parse each module function in its own traversal so fnPath has correct scope.
    // We need NodePath objects, which requires re-traversing with a visitor.
    const results: Record<string, string> = {};

    // Build a per-module-id lookup from the extracted fnNodes (by reference)
    const fnNodeToId = new Map<t.Node, string>();
    for (const { id, fnNode } of modules) {
        fnNodeToId.set(fnNode, id);
    }

    // Collect NodePaths by traversing the AST
    const capturedPaths = new Map<string, NodePath<t.FunctionExpression | t.ArrowFunctionExpression>>();

    traverse(ast, {
        FunctionExpression(path) {
            const id = fnNodeToId.get(path.node);
            if (id) capturedPaths.set(id, path as NodePath<t.FunctionExpression>);
        },
        ArrowFunctionExpression(path) {
            const id = fnNodeToId.get(path.node);
            if (id) capturedPaths.set(id, path as NodePath<t.ArrowFunctionExpression>);
        },
    });

    for (const { id, fnNode } of modules) {
        printMsg(MSG.Header, `[i] Processing Vue (webpack) module: ${id}`);
        const fnPath = capturedPaths.get(id);
        if (!fnPath) {
            printMsg(MSG.Warn, `[!] Could not get NodePath for module ${id} — skipping`);
            continue;
        }

        const params = fnNode.params;
        const moduleParam = params[0] && t.isIdentifier(params[0]) ? (params[0] as t.Identifier).name : "";
        const exportsParam = params[1] && t.isIdentifier(params[1]) ? (params[1] as t.Identifier).name : "";
        const requireParam = params[2] && t.isIdentifier(params[2]) ? (params[2] as t.Identifier).name : "";

        const entry: WebpackModuleEntry = {
            id,
            fnPath: fnPath as NodePath<t.ArrowFunctionExpression>,
            runtimeParam: "",
            moduleParam,
            exportsParam,
            requireParam,
        };

        const statements = transformWebpackModule(entry);
        const rawCode = validateAndFix(statements, id);
        if (rawCode === null) {
            printMsg(MSG.Warn, `[~] Module ${id} skipped due to unresolvable syntax errors`);
            continue;
        }

        results[id] = rawCode;
    }

    return results;
};

export default refactorVueWebpack;
