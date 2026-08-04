// ECMAScript export reference: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/export
// ECMAScript import reference: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/import

import parser from "@babel/parser";
import _traverse, { NodePath } from "@babel/traverse";
import _generator from "@babel/generator";
import * as t from "@babel/types";
import { cs_mast_init, ScatCategory } from "@shriyanss/cs-mast";
import { Chunk } from "../../utility/interfaces.js";
import { isInModuleMap } from "./helpers.js";
import { validateAndFix } from "./validator.js";
import {
    ModuleEntry,
    transformModule,
    transformIndexStatements,
    applyModuleCleanupPasses,
    applyLibraryImportRewriting,
    renameRouteComponents,
} from "./transform.js";
import { LibraryModuleInfo, classifyLibraryModule, resolveReexportChains } from "./library-classify.js";
import { printMsg, MSG } from "../../utility/printMsg.js";

const traverse = (_traverse.default ?? _traverse) as typeof _traverse.default;
const generate = (_generator as unknown as { default: typeof _generator }).default ?? _generator;

// scat config used when computing experiment-baseline signatures (matches
// refactor_observations/feature-signatures/<feature>/lit-decl-loop-cond/collisions.json).
const LIB_SIG_SCAT: ScatCategory[] = ["lit", "decl", "loop", "cond"];

// Returns the body statements of a top-level IIFE (e.g. `(() => { … })()`), or null.
const findIifeBody = (program: t.Program): t.Statement[] | null => {
    for (const stmt of program.body) {
        if (!t.isExpressionStatement(stmt)) continue;
        const expr = stmt.expression;
        if (!t.isCallExpression(expr) || expr.arguments.length !== 0) continue;
        const callee = expr.callee;
        if (
            (t.isArrowFunctionExpression(callee) || t.isFunctionExpression(callee)) &&
            t.isBlockStatement(callee.body)
        ) {
            return callee.body.body;
        }
    }
    return null;
};

// Returns true when stmt is the webpack lazy-chunk push call:
// (self.webpackChunk...||[]).push([[chunkId,...], {moduleId: fn, ...}])
const isLazyChunkPushStmt = (stmt: t.Statement): boolean => {
    if (!t.isExpressionStatement(stmt)) return false;
    const expr = stmt.expression;
    if (!t.isCallExpression(expr)) return false;
    const callee = expr.callee;
    return t.isMemberExpression(callee) && t.isIdentifier((callee as t.MemberExpression).property, { name: "push" });
};

// Returns true when a VariableDeclarator's init is the webpack numeric module map
// object (every property has a NumericLiteral key and a function value).
const isModuleMapDeclarator = (d: t.VariableDeclarator): boolean => {
    if (!t.isObjectExpression(d.init)) return false;
    const props = (d.init as t.ObjectExpression).properties;
    if (props.length === 0) return false;
    return props.every((p) => {
        if (t.isObjectProperty(p))
            return (
                t.isNumericLiteral(p.key) && (t.isFunctionExpression(p.value) || t.isArrowFunctionExpression(p.value))
            );
        if (t.isObjectMethod(p)) return t.isNumericLiteral(p.key);
        return false;
    });
};

/**
 * Rewrites a webpack-bundled React chunk by splitting the numeric module map
 * into individual ECMAScript module files.
 *
 *   Step 1 – Find the `var X = { <numId>: function(e,n,t){…}, … }` module map.
 *   Step 2 – For each module:
 *              a) Convert `<moduleParam>.exports = <requireParam>(N)` → `export * from "./N.js"`
 *                 (and `<moduleParam>.exports = <expr>` → `export default <expr>`),
 *                 including inside top-level sequence expressions.
 *              b) Convert `<exportsParam>.<propName> = <rhs>` → ECMAScript named exports
 *                 (per MDN export reference) for any module that has an exports param.
 *              c) Hoist `var <name> = <requireParam>(N)` to `import * as <name> from "./N.js"`.
 *              d) Replace remaining inline `<requireParam>(N)` calls with a synthesized
 *                 namespace import reference.
 *              e) Strip the outer function wrapper.
 *   Step 3 – Validate generated code with Babel; iteratively drop/downgrade statements
 *              that still cause parse errors.
 *   Step 4 – Collect all IIFE body statements that are NOT part of the module map and
 *              write them to `index.js` (entrypoint bootstrap, app component functions,
 *              the ReactDOM.render call, etc.).
 */
const isLibrarySig = (sig: string | undefined, libSigs: Set<string> | undefined): boolean =>
    !!(sig && libSigs && libSigs.has(sig));

// Minimum fraction of a module's sub-tree signatures that must match the library
// baseline before the module is classified as library code. A value of 1.0 means
// every signature must match (too strict — misses partial-lib modules). A value
// of 0.0 means any single match suffices (too loose — false-positives on app modules
// that happen to share a helper with library code). 0.5 is a reasonable default:
// pure library modules score close to 1.0 while app modules with inline CSS helpers
// or a stray shared utility typically score well below 0.5.
const LIB_CLASSIFICATION_THRESHOLD = 0.51;

// Hash a single module's function body using cs_mast_init and look the signature
// up against the count=18 baseline set. Returns true when the fraction of the
// module's sub-tree signatures that match the baseline exceeds LIB_CLASSIFICATION_THRESHOLD.
const moduleIsLibrary = (
    mod: ModuleEntry,
    libSigs: Set<string> | undefined,
    scatOverride?: ScatCategory[]
): boolean => {
    if (!libSigs || libSigs.size === 0) return false;
    const fnNode = mod.fnPath.node as t.FunctionExpression | t.ArrowFunctionExpression | t.ObjectMethod;
    if (!t.isBlockStatement((fnNode as { body?: t.Node }).body)) return false;
    const body = (fnNode as { body: t.BlockStatement }).body;
    try {
        const code = generate(body).code;
        const tree = cs_mast_init(code, {
            hash: "sha256",
            scat: scatOverride ?? LIB_SIG_SCAT,
            sinc: [],
            lang: "js",
            prsr: "@babel/parser",
        });
        const sigs = [...tree._signatureMap.keys()];
        if (sigs.length === 0) return false;
        const matchCount = sigs.filter((sig) => isLibrarySig(sig, libSigs)).length;
        const fraction = matchCount / sigs.length;
        return fraction >= LIB_CLASSIFICATION_THRESHOLD;
    } catch {
        // unparseable / unhashable — fall through and treat as non-library
    }
    return false;
};

// Returns true when a 1-param module looks like a style-loader runtime helper.
// Matches the addStyles module (contains domAPI + update) and the
// styleTagTransform module (sets cssText or calls createTextNode).
const isStyleLoaderModule = (mod: ModuleEntry): boolean => {
    if (mod.paramCount !== 1) return false;
    const fnNode = mod.fnPath.node as t.FunctionExpression | t.ArrowFunctionExpression | t.ObjectMethod;
    if (!t.isBlockStatement((fnNode as { body?: t.Node }).body)) return false;
    const body = (fnNode as { body: t.BlockStatement }).body;
    try {
        const code = generate(body).code;
        if (code.includes("domAPI") && code.includes("update")) return true;
        if (code.includes("styleSheet") && code.includes("cssText")) return true;
        if (code.includes("styleTagTransform") || code.includes("insertStyleElement")) return true;
    } catch {
        // unparseable
    }
    return false;
};

// Returns true when a 3-param module is a CSS content module (pushes a CSS array
// with an id + CSS string via requireParam.d).
const isCssModuleEntry = (mod: ModuleEntry): boolean => {
    if (mod.paramCount !== 3) return false;
    const fnNode = mod.fnPath.node as t.FunctionExpression | t.ArrowFunctionExpression | t.ObjectMethod;
    if (!t.isBlockStatement((fnNode as { body?: t.Node }).body)) return false;
    const body = (fnNode as { body: t.BlockStatement }).body;
    try {
        const code = generate(body).code;
        // CSS content modules push an array of [moduleId, cssString, ""] and register via .d
        if (code.includes(".push(") && code.includes(".id,") && code.includes(".d(")) return true;
    } catch {
        // unparseable
    }
    return false;
};

export type RefactorReactResult = {
    files: Record<string, string>;
    libModuleMap: Map<string, LibraryModuleInfo>;
};

const refactorReact = async (
    chunk: Chunk,
    libSigs?: Set<string>,
    externalLibModuleMap?: Map<string, LibraryModuleInfo>,
    classifyAllAsLibrary?: boolean,
    scatOverride?: ScatCategory[]
): Promise<RefactorReactResult> => {
    printMsg(MSG.Header, `[i] Processing React bundle: ${chunk.id}`);

    const ast = parser.parse(chunk.code, {
        sourceType: "unambiguous",
        plugins: ["jsx", "typescript"],
        errorRecovery: true,
    });

    const modules: ModuleEntry[] = [];

    const captureProperty = (path: NodePath<t.ObjectProperty>) => {
        if (!isInModuleMap(path)) return;
        const key = path.node.key;
        if (!t.isNumericLiteral(key)) {
            if (t.isStringLiteral(key) && /[a-zA-Z]/.test(key.value)) {
                printMsg(
                    MSG.Warn,
                    `[!] Alphanumeric module ID "${key.value}" detected — not yet supported, skipping (please open a PR)`
                );
            }
            return;
        }
        const value = path.node.value;
        if (!t.isFunctionExpression(value) && !t.isArrowFunctionExpression(value)) return;
        const id = String(key.value);
        const params = value.params;
        if (params.length > 3) {
            printMsg(MSG.Warn, `[!] Module ${id} has ${params.length} params — not yet researched, skipping`);
            return;
        }
        const moduleParam = params[0] && t.isIdentifier(params[0]) ? (params[0] as t.Identifier).name : "";
        const exportsParam = params[1] && t.isIdentifier(params[1]) ? (params[1] as t.Identifier).name : "";
        const requireParam =
            params.length >= 3 && t.isIdentifier(params[2]) ? (params[2] as t.Identifier).name : undefined;
        modules.push({
            id,
            fnPath: path.get("value") as NodePath<t.FunctionExpression | t.ArrowFunctionExpression>,
            paramCount: params.length,
            moduleParam,
            exportsParam,
            requireParam,
        });
    };

    const captureMethod = (path: NodePath<t.ObjectMethod>) => {
        if (!isInModuleMap(path)) return;
        const key = path.node.key;
        if (!t.isNumericLiteral(key)) {
            if (t.isStringLiteral(key) && /[a-zA-Z]/.test(key.value)) {
                printMsg(
                    MSG.Warn,
                    `[!] Alphanumeric module ID "${key.value}" detected — not yet supported, skipping (please open a PR)`
                );
            }
            return;
        }
        const id = String(key.value);
        const params = path.node.params;
        if (params.length > 3) {
            printMsg(MSG.Warn, `[!] Module ${id} has ${params.length} params — not yet researched, skipping`);
            return;
        }
        const moduleParam = params[0] && t.isIdentifier(params[0]) ? (params[0] as t.Identifier).name : "";
        const exportsParam = params[1] && t.isIdentifier(params[1]) ? (params[1] as t.Identifier).name : "";
        const requireParam =
            params.length >= 3 && t.isIdentifier(params[2]) ? (params[2] as t.Identifier).name : undefined;
        modules.push({
            id,
            fnPath: path as unknown as NodePath<t.ObjectMethod>,
            paramCount: params.length,
            moduleParam,
            exportsParam,
            requireParam,
        });
    };

    traverse(ast, {
        ObjectProperty: captureProperty,
        ObjectMethod: captureMethod,
    });

    printMsg(MSG.Header, `[i] Found ${modules.length} modules`);

    // Detect lazy chunk bundles: no IIFE wrapper, program body is entirely push() calls.
    // Modules in lazy chunks are always application code — skip library classification for them.
    // Also don't generate index.js from the push statement (it contains no bootstrap logic).
    const iifeBody = findIifeBody(ast.program);
    const isLazyBundle =
        iifeBody === null && ast.program.body.length > 0 && ast.program.body.every(isLazyChunkPushStmt);
    if (isLazyBundle) {
        printMsg(MSG.Header, `[i] Detected lazy chunk format — skipping library classification`);
    }

    const files: Record<string, string> = {};

    // moduleId → LibraryModuleInfo for modules that are library-classified (in this chunk)
    const libModuleMap = new Map<string, LibraryModuleInfo>();

    let libraryCount = 0;
    // Collect non-library module statements before applying Pass D, so we can use the
    // fully-resolved libModuleMap (including re-export chains) when rewriting imports.
    const pendingModules: Array<{ id: string; statements: t.Statement[] }> = [];

    for (const mod of modules) {
        // classifyAllAsLibrary: used for vendor chunks outside mapped.json where we want
        // to extract library export maps without generating any output files.
        const isLib = classifyAllAsLibrary || (!isLazyBundle && moduleIsLibrary(mod, libSigs, scatOverride));
        // Detect style-loader and CSS content modules regardless of baseline signatures.
        if (!classifyAllAsLibrary && !isLib && !isLazyBundle) {
            const styleLoaderType = isStyleLoaderModule(mod)
                ? "style-loader"
                : isCssModuleEntry(mod)
                  ? "css-module"
                  : null;
            if (styleLoaderType !== null) {
                printMsg(MSG.Info, `[-] Module ${mod.id} detected as ${styleLoaderType} — skipping`);
                libModuleMap.set(mod.id, { type: styleLoaderType, exportMap: new Map() });
                libraryCount++;
                continue;
            }
        }
        if (isLib) {
            printMsg(MSG.Info, `[-] Module ${mod.id} matches library baseline — skipping`);
            libraryCount++;
            // Classify the library module so import rewriting can use proper named imports
            const info = classifyLibraryModule(mod);
            libModuleMap.set(mod.id, info);
            continue;
        }
        const statements = applyModuleCleanupPasses(transformModule(mod));
        pendingModules.push({ id: mod.id, statements });
    }
    // Resolve re-export chains (e.g. 338 → 247/react-dom-client, 540 → 287/React) so shim modules
    // get the right library type. Always run for vendor pre-scans (classifyAllAsLibrary), and for
    // normal non-lazy chunks when a library baseline is provided.
    if (classifyAllAsLibrary || (!isLazyBundle && libSigs && libSigs.size > 0)) {
        if (!isLazyBundle && libSigs && libSigs.size > 0) {
            printMsg(MSG.Header, `[i] Library modules skipped: ${libraryCount}/${modules.length}`);
        }
        resolveReexportChains(libModuleMap, modules);
    }

    // Merged map: prefer locally-classified entries over external ones (local classification
    // is more precise for this specific bundle version).
    const mergedLibMap = new Map<string, LibraryModuleInfo>([...(externalLibModuleMap ?? []), ...libModuleMap]);

    // Apply Pass D (library-aware import rewriting) using the merged map, then validate.
    for (const { id, statements } of pendingModules) {
        const afterD = mergedLibMap.size > 0 ? applyLibraryImportRewriting(statements, mergedLibMap) : statements;
        const afterRename = renameRouteComponents(afterD);
        const code = validateAndFix(afterRename, id);
        if (code === null) {
            printMsg(MSG.Warn, `[~] Module ${id} skipped due to unresolvable syntax errors`);
            continue;
        }
        files[id] = code;
    }

    // Collect everything in the IIFE body that is NOT the module-map variable into index.js.
    // Skip this step for lazy chunks — their push statement contains no bootstrap logic.
    if (!isLazyBundle) {
        const topLevel = iifeBody ?? ast.program.body;
        const indexStatements: t.Statement[] = [];
        for (const stmt of topLevel) {
            if (t.isVariableDeclaration(stmt)) {
                const remaining = stmt.declarations.filter((d) => !isModuleMapDeclarator(d));
                if (remaining.length > 0) indexStatements.push(t.variableDeclaration(stmt.kind, remaining));
            } else {
                indexStatements.push(stmt);
            }
        }
        if (indexStatements.length > 0) {
            printMsg(MSG.Header, `[i] Writing ${indexStatements.length} non-module statements to index.js`);
            const transformed = transformIndexStatements(
                indexStatements,
                mergedLibMap.size > 0 ? mergedLibMap : undefined
            );
            const indexCode = validateAndFix(transformed, "index");
            if (indexCode !== null) files["index"] = indexCode;
        }
    }

    return { files, libModuleMap };
};

export default refactorReact;
