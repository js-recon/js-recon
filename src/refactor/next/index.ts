import parser from "@babel/parser";
import _traverse from "@babel/traverse";
import _generator from "@babel/generator";
import { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import { cs_mast_init, ScatCategory } from "@shriyanss/cs-mast";
import { Chunk } from "../../utility/interfaces.js";
import { TurboModuleEntry, WebpackModuleEntry, transformModule, transformWebpackModule } from "./transform.js";
import { validateAndFix } from "./validator.js";
import { printMsg, MSG } from "../../utility/printMsg.js";

const generate = (_generator as unknown as { default: typeof _generator }).default ?? _generator;

// scat categories used when classifying modules as library vs application code.
const LIB_SIG_SCAT: ScatCategory[] = ["lit", "decl", "loop", "cond"];

// Minimum fraction of a module's sub-tree signatures that must match the library
// baseline before the module is classified as library code.
const LIB_CLASSIFICATION_THRESHOLD = 0.51;

// Hash a module's function body and check whether its sub-tree signatures
// overlap the cross-app library baseline above the classification threshold.
const moduleIsLibrary = (
    fnNode: t.ArrowFunctionExpression | t.FunctionExpression | t.FunctionDeclaration,
    libSigs: Set<string>,
    scatOverride?: ScatCategory[]
): boolean => {
    if (!t.isBlockStatement(fnNode.body)) return false;
    try {
        const code = generate(fnNode.body).code;
        const tree = cs_mast_init(code, {
            hash: "sha256",
            scat: scatOverride ?? LIB_SIG_SCAT,
            sinc: [],
            lang: "js",
            prsr: "@babel/parser",
        });
        const sigs = [...tree._signatureMap.keys()];
        if (sigs.length === 0) return false;
        const matchCount = sigs.filter((sig) => libSigs.has(sig)).length;
        return matchCount / sigs.length >= LIB_CLASSIFICATION_THRESHOLD;
    } catch {
        return false;
    }
};

/**
 * Refactors a single Next.js (webpack) chunk into an ECMAScript module file.
 *
 * Chunk code format (from mapped.json): `3899:(e,t,r)=>{"use strict";...}`
 * Param order: params[0]=module, params[1]=exports, params[2]=require
 *
 * Export forms handled:
 *   - Object.defineProperty(t,"name",{get:fn}) — named exports
 *   - for(var k in map) ODP(t,k,...) — for-in batch exports
 *   - r.d(t,{name:()=>local}) — webpack require.d (rare)
 *   - e.exports = VALUE — CJS default export
 *   - e.exports = r(N) — CJS re-export (→ export * from './N.js')
 *
 * Require forms handled:
 *   - var x = r(N) — hoisted to import * as x from './N.js'
 *   - r(N) inline — replaced with hoisted identifier
 *   - r(N); standalone — becomes import './N.js' (side-effect)
 */
export const refactorNextWebpack = async (
    chunk: Chunk,
    libSigs?: Set<string>,
    scatOverride?: ScatCategory[]
): Promise<Record<string, string>> => {
    printMsg(MSG.Header, `[i] Processing Next.js (webpack) chunk: ${chunk.id}`);

    let ast: t.File;
    try {
        ast = parser.parse(chunk.code, {
            sourceType: "unambiguous",
            plugins: ["jsx", "typescript"],
            errorRecovery: true,
        });
    } catch {
        printMsg(MSG.Warn, `[!] Failed to parse webpack chunk ${chunk.id} — skipping`);
        return {};
    }

    let captured: WebpackModuleEntry | null = null;

    // A node is the genuine top-level module wrapper only if its nearest enclosing
    // statement is a direct child of Program — this rejects arrow/function nodes
    // nested anywhere inside another function body, even when their immediate
    // parent happens to be an AssignmentExpression (e.g. an inner `n = () => {...}`).
    const isGenuineTopLevel = (path: NodePath): boolean => {
        const statementParent = path.getStatementParent();
        return !!statementParent?.parentPath?.isProgram();
    };

    traverse(ast, {
        // getWebpackConnections.ts synthesizes `function webpack_<chunk.id>(...)` whenever
        // the original bundle module was itself a `function` expression (webpack 4/SWC
        // output) — the dominant form on real-world bundles, not the arrow form below.
        FunctionDeclaration(path: NodePath<t.FunctionDeclaration>) {
            if (captured) return;
            if (path.node.id?.name !== `webpack_${chunk.id}`) return;
            if (!isGenuineTopLevel(path)) return;

            const params = path.node.params;
            if (params.length > 3) return;

            const moduleParam = params[0] && t.isIdentifier(params[0]) ? (params[0] as t.Identifier).name : "";
            const exportsParam = params[1] && t.isIdentifier(params[1]) ? (params[1] as t.Identifier).name : "";
            const requireParam = params[2] && t.isIdentifier(params[2]) ? (params[2] as t.Identifier).name : "";

            captured = {
                id: chunk.id,
                fnPath: path,
                runtimeParam: "",
                moduleParam,
                exportsParam,
                requireParam,
            };
            path.stop();
        },
        ArrowFunctionExpression(path: NodePath<t.ArrowFunctionExpression>) {
            if (captured) return;
            // Accept the module wrapper at any of these positions:
            //   func_NNN = (e, t, r) => {...}  → parent is AssignmentExpression
            //   (e, t, r) => {...}              → parent is ExpressionStatement or Program
            const parent = path.parentPath;
            const isTopLevelShape =
                parent?.isAssignmentExpression() || parent?.isExpressionStatement() || parent?.isProgram();
            if (!isTopLevelShape || !isGenuineTopLevel(path)) return;

            const params = path.node.params;
            if (params.length > 3) return;

            const moduleParam = params[0] && t.isIdentifier(params[0]) ? (params[0] as t.Identifier).name : "";
            const exportsParam = params[1] && t.isIdentifier(params[1]) ? (params[1] as t.Identifier).name : "";
            const requireParam = params[2] && t.isIdentifier(params[2]) ? (params[2] as t.Identifier).name : "";

            captured = {
                id: chunk.id,
                fnPath: path,
                runtimeParam: "",
                moduleParam,
                exportsParam,
                requireParam,
            };
            path.stop();
        },
    });

    if (!captured) {
        printMsg(MSG.Warn, `[!] No module function found in webpack chunk ${chunk.id} — skipping`);
        return {};
    }

    // CS-MAST library classification: skip modules that match the cross-app baseline.
    if (libSigs && libSigs.size > 0) {
        const fnNode = (captured as WebpackModuleEntry).fnPath.node;
        if (moduleIsLibrary(fnNode, libSigs, scatOverride)) {
            printMsg(MSG.Info, `[-] Module ${chunk.id} matches library baseline — skipping`);
            return {};
        }
    }

    const statements = transformWebpackModule(captured);
    const code = validateAndFix(statements, chunk.id);
    if (code === null) {
        printMsg(MSG.Warn, `[~] Module ${chunk.id} skipped due to unresolvable syntax errors`);
        return {};
    }

    return { [chunk.id]: code };
};

const traverse = (_traverse.default ?? _traverse) as typeof _traverse.default;

/**
 * Refactors a single Next.js (Turbopack) chunk into an ECMAScript module file.
 *
 * Supported module formats in a turbopack bundle:
 *
 * 1. Turbopack format: `func_NNN = (module, exports, require) => { ... }`
 *    - module  (params[0]): module object — rarely used
 *    - exports (params[1]): exports target — ODP(exports,"name",{get:fn}) registers named exports;
 *                           turbopack IIFE batch export !(fn)(exports, {name:getter,...}) also handled
 *    - require (params[2]): require function — require(N) imports module N; may be absent for 0/1/2-param modules
 *
 * 2. Webpack-style format: code is the module arrow function directly `(module, exports, require) => {...}`
 *    - Uses require.d(exports, {...}) for export registration
 *    - Uses require.r(exports) as ES module marker (dropped)
 *    - Same param order as turbopack
 *
 * Returns a map { [chunkId]: code } or {} if the chunk cannot be processed.
 */
const refactorNextTurbopack = async (chunk: Chunk): Promise<Record<string, string>> => {
    printMsg(MSG.Header, `[i] Processing Next.js (Turbopack) chunk: ${chunk.id}`);

    const ast = parser.parse(chunk.code, {
        sourceType: "unambiguous",
        plugins: ["jsx", "typescript"],
        errorRecovery: true,
    });

    // Detect format by looking at the code prefix.
    // Turbopack chunks start with `func_NNN = ` (e.g. "func_170 = (e, t, r) => {...}").
    // Webpack-style chunks are just the module function: "(e,t,r)=>{...}" or "e=>{...}".
    const isTurbopackFormat = /^\s*func_\d+\s*=/.test(chunk.code);

    if (isTurbopackFormat) {
        return refactorTurbopackModule(chunk, ast);
    } else {
        return refactorWebpackModule(chunk, ast);
    }
};

/**
 * Handles `func_NNN = (module, exports, require) => { ... }` format.
 * Looks for the top-level assignment and extracts the arrow function params.
 */
async function refactorTurbopackModule(chunk: Chunk, ast: t.File): Promise<Record<string, string>> {
    let captured: TurboModuleEntry | null = null;

    traverse(ast, {
        ArrowFunctionExpression(path: NodePath<t.ArrowFunctionExpression>) {
            // Only capture direct assignments: `func_NNN = (e, t, r) => {...}`
            if (!path.parentPath?.isAssignmentExpression() && !path.parentPath?.isVariableDeclarator()) return;

            const params = path.node.params;
            if (params.length > 3) {
                printMsg(MSG.Warn, `[!] Module ${chunk.id} has ${params.length} params — skipping`);
                path.stop();
                return;
            }

            // Turbopack: params[0]=runtime (e.r(N)), params[1]=module (t.exports), params[2]=exports (ODP target)
            const runtimeParam = params[0] && t.isIdentifier(params[0]) ? (params[0] as t.Identifier).name : "";
            const moduleParam = params[1] && t.isIdentifier(params[1]) ? (params[1] as t.Identifier).name : "";
            const exportsParam = params[2] && t.isIdentifier(params[2]) ? (params[2] as t.Identifier).name : "";

            captured = {
                id: chunk.id,
                fnPath: path,
                runtimeParam,
                moduleParam,
                exportsParam,
                requireParam: "", // pure turbopack chunks have no webpack-style require
            };
            path.stop();
        },
    });

    if (!captured) {
        printMsg(MSG.Warn, `[!] No module function found in chunk ${chunk.id} — skipping`);
        return {};
    }

    const statements = transformModule(captured);
    const code = validateAndFix(statements, chunk.id);
    if (code === null) {
        printMsg(MSG.Warn, `[~] Module ${chunk.id} skipped due to unresolvable syntax errors`);
        return {};
    }

    return { [chunk.id]: code };
}

/**
 * Handles webpack-style `(module, exports, require) => { ... }` format.
 * The chunk code IS the module function itself (no func_NNN= prefix).
 */
async function refactorWebpackModule(chunk: Chunk, ast: t.File): Promise<Record<string, string>> {
    let captured: WebpackModuleEntry | null = null;

    traverse(ast, {
        ArrowFunctionExpression(path: NodePath<t.ArrowFunctionExpression>) {
            // For webpack-style, the function may be at top level or inside an object property.
            // Accept any top-level arrow function.
            const params = path.node.params;
            if (params.length > 3) return;

            // Skip deeply nested functions — only want the outermost module wrapper.
            if (path.parentPath?.parentPath?.parentPath) return;

            // Webpack-style: params[0]=module, params[1]=exports (t), params[2]=require (r.d/r.r)
            const moduleParam = params[0] && t.isIdentifier(params[0]) ? (params[0] as t.Identifier).name : "";
            const exportsParam = params[1] && t.isIdentifier(params[1]) ? (params[1] as t.Identifier).name : "";
            const requireParam = params[2] && t.isIdentifier(params[2]) ? (params[2] as t.Identifier).name : "";

            if (!captured) {
                captured = {
                    id: chunk.id,
                    fnPath: path,
                    runtimeParam: "", // webpack-style has no turbopack runtime
                    moduleParam,
                    exportsParam,
                    requireParam,
                };
            }
            path.stop();
        },
    });

    if (!captured) {
        printMsg(MSG.Warn, `[!] No module function found in webpack chunk ${chunk.id} — skipping`);
        return {};
    }

    const statements = transformWebpackModule(captured);
    const code = validateAndFix(statements, chunk.id);
    if (code === null) {
        printMsg(MSG.Warn, `[~] Module ${chunk.id} skipped due to unresolvable syntax errors`);
        return {};
    }

    return { [chunk.id]: code };
}

export default refactorNextTurbopack;
