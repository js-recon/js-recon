import * as t from "@babel/types";
import generate from "@babel/generator";
import { ModuleEntry } from "./transform.js";

export type LibraryType =
    "react" | "react-dom-client" | "react-jsx-runtime" | "react-router-dom" | "style-loader" | "css-module" | "unknown";

export interface LibraryModuleInfo {
    type: LibraryType;
    /** Minified export prop → canonical name. e.g. "H" → "createRoot" */
    exportMap: Map<string, string>;
}

export const REACT_CANONICAL = new Set([
    "useState",
    "useEffect",
    "useRef",
    "useMemo",
    "useCallback",
    "useContext",
    "useReducer",
    "useLayoutEffect",
    "useDebugValue",
    "useId",
    "useTransition",
    "useDeferredValue",
    "useInsertionEffect",
    "useImperativeHandle",
    "useSyncExternalStore",
    "createElement",
    "Fragment",
    "Component",
    "PureComponent",
    "createContext",
    "forwardRef",
    "memo",
    "Profiler",
    "Suspense",
    "StrictMode",
    "createRef",
    "isValidElement",
    "Children",
    "cloneElement",
    "startTransition",
    "lazy",
    "version",
    "createPortal",
    "flushSync",
    "act",
    "cache",
]);

// Deliberately excludes "Fragment" — React itself also exports Fragment, so it is not
// a distinctive marker for classification. Use only jsx/jsxs/jsxDEV which are unique to
// this package. For rewriting purposes, Fragment is handled in resolveLibraryProp.
export const JSX_RUNTIME_CANONICAL = new Set(["jsx", "jsxs", "jsxDEV"]);
export const REACT_DOM_CLIENT_CANONICAL = new Set(["createRoot", "hydrateRoot"]);

// Ordered: hooks first (most specific detection via string patterns), then child
// components (Route before Routes to avoid ambiguity in error messages), then
// wrapper/parent components.
export const REACT_ROUTER_DOM_CANONICAL = new Set([
    // Hooks — detected by backtick-quoted name or call pattern in error strings
    "useNavigate",
    "useLocation",
    "useSearchParams",
    "useParams",
    "useMatch",
    "useMatches",
    "useRoutes",
    "useOutlet",
    "useOutletContext",
    "useNavigationType",
    "useResolvedPath",
    "useHref",
    "useLinkClickHandler",
    "useInRouterContext",
    "useBlocker",
    "useBeforeUnload",
    // Child/inner components — Route before Routes to match <Route> first in error messages
    "Route",
    "Link",
    "NavLink",
    "Navigate",
    "Outlet",
    // Wrapper/parent components
    "Routes",
    "BrowserRouter",
    "HashRouter",
    "MemoryRouter",
    "RouterProvider",
]);

const LIBRARY_SOURCE: Record<LibraryType, string> = {
    react: "react",
    "react-dom-client": "react-dom/client",
    "react-jsx-runtime": "react/jsx-runtime",
    "react-router-dom": "react-router-dom",
    "style-loader": "",
    "css-module": "",
    unknown: "",
};

export const librarySource = (type: LibraryType): string => LIBRARY_SOURCE[type];

function scanExportMap(mod: ModuleEntry): Map<string, string> {
    const map = new Map<string, string>();
    const { exportsParam } = mod;
    if (!exportsParam) return map;
    const body = (mod.fnPath.node as { body?: t.Node }).body;
    if (!body || !t.isBlockStatement(body)) return map;

    for (const stmt of body.body) {
        if (!t.isExpressionStatement(stmt)) continue;
        const exprs = t.isSequenceExpression(stmt.expression) ? stmt.expression.expressions : [stmt.expression];
        for (const ex of exprs) {
            if (!t.isAssignmentExpression(ex) || ex.operator !== "=") continue;
            const lhs = ex.left;
            if (!t.isMemberExpression(lhs) || lhs.computed) continue;
            if (!t.isIdentifier(lhs.object, { name: exportsParam })) continue;
            const minName = t.isIdentifier(lhs.property) ? lhs.property.name : null;
            if (!minName) continue;
            const rhs = ex.right;
            if (t.isMemberExpression(rhs) && !rhs.computed && t.isIdentifier(rhs.property)) {
                map.set(minName, (rhs.property as t.Identifier).name);
            } else if (t.isIdentifier(rhs)) {
                map.set(minName, (rhs as t.Identifier).name);
            } else {
                // RHS is a complex expression (e.g. function declaration) — record the key
                // with a self-reference so it participates in canonical classification checks.
                map.set(minName, minName);
            }
        }
    }
    return map;
}

/** Reads `requireParam.d(exportsParam, {key: () => localVar})` webpack ESM registration patterns. */
function scanNdExportKeys(mod: ModuleEntry): Map<string, string> {
    const map = new Map<string, string>(); // exportedKey → localVarName
    const { exportsParam, requireParam } = mod;
    if (!exportsParam || !requireParam) return map;
    const body = (mod.fnPath.node as { body?: t.Node }).body;
    if (!body || !t.isBlockStatement(body)) return map;

    for (const stmt of (body as t.BlockStatement).body) {
        if (!t.isExpressionStatement(stmt)) continue;
        const exprs = t.isSequenceExpression(stmt.expression)
            ? (stmt.expression.expressions as t.Expression[])
            : [stmt.expression];
        for (const expr of exprs) {
            if (!t.isCallExpression(expr)) continue;
            const callee = expr.callee;
            if (!t.isMemberExpression(callee) || callee.computed) continue;
            if (!t.isIdentifier(callee.object, { name: requireParam })) continue;
            if (!t.isIdentifier(callee.property, { name: "d" })) continue;
            if (expr.arguments.length < 2) continue;
            if (!t.isIdentifier(expr.arguments[0], { name: exportsParam })) continue;
            const objArg = expr.arguments[1];
            if (!t.isObjectExpression(objArg)) continue;
            for (const prop of (objArg as t.ObjectExpression).properties) {
                if (!t.isObjectProperty(prop) || prop.computed) continue;
                const key = t.isIdentifier(prop.key)
                    ? (prop.key as t.Identifier).name
                    : t.isStringLiteral(prop.key)
                      ? prop.key.value
                      : null;
                if (!key) continue;
                const val = prop.value as t.Expression;
                // Arrow: () => localVar
                if (t.isArrowFunctionExpression(val) && t.isIdentifier(val.body)) {
                    map.set(key, (val.body as t.Identifier).name);
                }
            }
        }
    }
    return map;
}

/** Reads `localVar.displayName = "CanonicalName"` patterns in the module body. */
function scanDisplayNames(mod: ModuleEntry): Map<string, string> {
    const map = new Map<string, string>(); // localVarName → displayName
    const body = (mod.fnPath.node as { body?: t.Node }).body;
    if (!body || !t.isBlockStatement(body)) return map;

    for (const stmt of (body as t.BlockStatement).body) {
        if (!t.isExpressionStatement(stmt)) continue;
        const exprs = t.isSequenceExpression(stmt.expression)
            ? (stmt.expression.expressions as t.Expression[])
            : [stmt.expression];
        for (const expr of exprs) {
            if (!t.isAssignmentExpression(expr) || expr.operator !== "=") continue;
            const lhs = expr.left;
            if (!t.isMemberExpression(lhs) || lhs.computed) continue;
            if (!t.isIdentifier(lhs.property, { name: "displayName" })) continue;
            if (!t.isIdentifier(lhs.object)) continue;
            const rhs = expr.right;
            if (!t.isStringLiteral(rhs)) continue;
            map.set((lhs.object as t.Identifier).name, rhs.value);
        }
    }
    return map;
}

/**
 * Extracts the most specific canonical name hint from generated body code.
 *
 * Priority order (descending confidence):
 *   1. Backtick-quoted: `canonical` in string literal (e.g. "cannot use `useSearchParams`")
 *   2. Call-site mention: canonical( in code (e.g. "useLocation() may be used")
 *   3. JSX element mention: <canonical> in string (e.g. "A <Route> is only ever")
 *   4. Outlet — .outlet property access is unique to the Outlet component
 *   5. useParams — ?.params return from route matches is unique to useParams
 *   6. BrowserRouter — basename: as destructuring prop key is unique to BrowserRouter
 */
function extractCanonicalFromCode(bodyCode: string, canonicalSet: Set<string>): string | null {
    // Priority 1: backtick-quoted form inside error strings
    for (const canonical of canonicalSet) {
        if (bodyCode.includes("`" + canonical + "`")) return canonical;
    }
    // Priority 2: call-site mention (e.g. "useLocation() may be used only in...")
    for (const canonical of canonicalSet) {
        if (bodyCode.includes(canonical + "(")) return canonical;
    }
    // Priority 3: JSX element mention (e.g. "A <Route> is only ever to be used as child of <Routes>")
    // Route is in the set before Routes so <Route> matches first, avoiding ambiguity.
    for (const canonical of canonicalSet) {
        if (bodyCode.includes("<" + canonical + ">")) return canonical;
    }
    // Priority 4: Outlet — the .outlet property of the router context is unique
    if (canonicalSet.has("Outlet") && bodyCode.includes(".outlet")) return "Outlet";
    // Priority 5: useParams — returns ?.params from the deepest route match
    if (canonicalSet.has("useParams") && bodyCode.includes("?.params")) return "useParams";
    // Priority 6: BrowserRouter — basename as a destructuring prop key
    if (canonicalSet.has("BrowserRouter") && bodyCode.includes("basename:")) return "BrowserRouter";
    // Priority 7: Routes — the only react-router-dom component whose props destructure
    // both `children` and `location`. Destructuring keys survive minification.
    if (canonicalSet.has("Routes") && bodyCode.includes("children:") && bodyCode.includes("location:")) return "Routes";
    return null;
}

/**
 * Builds an {exportedKey → canonicalName} map for modules that use the webpack ESM
 * registration format `requireParam.d(exportsParam, {key: ()=>localVar})`.
 * Combines displayName assignments and body-code scanning to recover canonical names.
 */
function buildNdCanonicalMap(mod: ModuleEntry, canonicalSet: Set<string>): Map<string, string> {
    const result = new Map<string, string>();

    const keyToLocal = scanNdExportKeys(mod);
    if (keyToLocal.size === 0) return result;

    const displayNames = scanDisplayNames(mod);

    // Build localVar → declaration node map from the module body
    const body = (mod.fnPath.node as { body?: t.Node }).body;
    if (!body || !t.isBlockStatement(body)) return result;

    const localToNode = new Map<string, t.Node>();
    for (const stmt of (body as t.BlockStatement).body) {
        if (t.isFunctionDeclaration(stmt) && stmt.id) {
            localToNode.set(stmt.id.name, stmt);
        }
        if (t.isVariableDeclaration(stmt)) {
            for (const decl of stmt.declarations) {
                if (t.isIdentifier(decl.id) && decl.init) {
                    localToNode.set((decl.id as t.Identifier).name, decl.init);
                }
            }
        }
    }

    for (const [exportKey, localVar] of keyToLocal) {
        // displayName is the highest-confidence signal (e.g. Link.displayName = "Link")
        const fromDisplay = displayNames.get(localVar);
        if (fromDisplay && canonicalSet.has(fromDisplay)) {
            result.set(exportKey, fromDisplay);
            continue;
        }

        // Scan the function/variable body code for canonical name hints
        const node = localToNode.get(localVar);
        if (node) {
            try {
                const code = generate(node).code;
                const canonical = extractCanonicalFromCode(code, canonicalSet);
                if (canonical) result.set(exportKey, canonical);
            } catch {
                // generation failed — skip
            }
        }
    }

    return result;
}

export function classifyLibraryModule(mod: ModuleEntry): LibraryModuleInfo {
    const exportMap = scanExportMap(mod);
    // Check both keys (prop names as exported, e.g. "jsx") AND values (canonical from RHS, e.g. "createRoot").
    // Keys cover modules that export with canonical names directly (React, jsx-runtime).
    // Values cover shim modules that rename (e.g. react-dom/client: H → createRoot).
    const keys = [...exportMap.keys()];
    const vals = [...exportMap.values()];
    if (keys.some((k) => REACT_DOM_CLIENT_CANONICAL.has(k)) || vals.some((v) => REACT_DOM_CLIENT_CANONICAL.has(v)))
        return { type: "react-dom-client", exportMap };
    if (keys.some((k) => JSX_RUNTIME_CANONICAL.has(k)) || vals.some((v) => JSX_RUNTIME_CANONICAL.has(v)))
        return { type: "react-jsx-runtime", exportMap };
    if (keys.some((k) => REACT_CANONICAL.has(k)) || vals.some((v) => REACT_CANONICAL.has(v)))
        return { type: "react", exportMap };

    // Try the webpack ESM registration format (n.d) with canonical name recovery.
    // Used by vendor chunks like react-router-dom that register exports via
    // requireParam.d(exportsParam, {key: () => localVar}) instead of exportsParam.key = val.
    const ndMap = buildNdCanonicalMap(mod, REACT_ROUTER_DOM_CANONICAL);
    if (ndMap.size > 0) {
        const ndVals = [...ndMap.values()];
        if (ndVals.some((v) => REACT_ROUTER_DOM_CANONICAL.has(v))) {
            return { type: "react-router-dom", exportMap: ndMap };
        }
    }

    return { type: "unknown", exportMap };
}

/**
 * Returns the numeric module ID that this module transparently re-exports
 * (i.e. its entire body is `moduleParam.exports = requireParam(N)`), or null.
 */
export function getReexportTarget(mod: ModuleEntry): number | null {
    const body = (mod.fnPath.node as { body?: t.Node }).body;
    if (!body || !t.isBlockStatement(body)) return null;
    const stmts = (body as t.BlockStatement).body;
    if (stmts.length !== 1) return null;
    const stmt = stmts[0];
    if (!t.isExpressionStatement(stmt)) return null;
    let expr = stmt.expression;
    // Handle SequenceExpression wrapping: `(DCE_check, e.exports = t(N))` — take last element.
    if (t.isSequenceExpression(expr)) {
        const exprs = (expr as t.SequenceExpression).expressions;
        expr = exprs[exprs.length - 1] as t.Expression;
    }
    if (!t.isAssignmentExpression(expr) || expr.operator !== "=") return null;
    const lhs = expr.left;
    if (!t.isMemberExpression(lhs) || lhs.computed) return null;
    if (!t.isIdentifier(lhs.object, { name: mod.moduleParam })) return null;
    if (!t.isIdentifier(lhs.property, { name: "exports" })) return null;
    if (!mod.requireParam) return null;
    const rhs = expr.right;
    if (!t.isCallExpression(rhs)) return null;
    if (!t.isIdentifier(rhs.callee, { name: mod.requireParam })) return null;
    if (rhs.arguments.length !== 1 || !t.isNumericLiteral(rhs.arguments[0])) return null;
    return (rhs.arguments[0] as t.NumericLiteral).value;
}

/**
 * Resolves transparent re-export chains in a module map.
 * E.g. 540 → 287 (React): if 287 is classified as 'react', 540 also becomes 'react'.
 * Runs up to 5 passes to handle chains of length > 1.
 */
export function resolveReexportChains(libModuleMap: Map<string, LibraryModuleInfo>, modules: ModuleEntry[]): void {
    for (let pass = 0; pass < 5; pass++) {
        let changed = false;
        for (const mod of modules) {
            const info = libModuleMap.get(mod.id);
            if (!info || info.type !== "unknown") continue;
            const targetId = getReexportTarget(mod);
            if (targetId === null) continue;
            const targetInfo = libModuleMap.get(String(targetId));
            if (targetInfo && targetInfo.type !== "unknown") {
                libModuleMap.set(mod.id, { type: targetInfo.type, exportMap: targetInfo.exportMap });
                changed = true;
            }
        }
        if (!changed) break;
    }
}
