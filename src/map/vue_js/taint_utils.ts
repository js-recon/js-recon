import parser from "@babel/parser";
import _traverse from "@babel/traverse";
import fs from "fs";
import { resolveNodeValue, memberChainToString } from "../next_js/utils.js";

const traverse = (_traverse.default ?? _traverse) as typeof _traverse.default;

export interface EnclosingFn {
    bindingName: string | null;
    firstParamName: string | null;
    paramNames: (string | null)[];
    node: any;
    file: string;
    // Outer named/bindable functions, ordered innermost→outermost. Lets the
    // taint helpers resolve a `[param:X]` against whichever enclosing scope
    // actually declared X — bundled code commonly nests the resolveNodeValue
    // callsite inside an anonymous Promise-chain callback whose own params
    // don't include X.
    parent?: EnclosingFn | null;
}

const getParamName = (paramNode: any): string | null => {
    if (!paramNode) return null;
    if (paramNode.type === "Identifier") return paramNode.name;
    if (paramNode.type === "AssignmentPattern" && paramNode.left?.type === "Identifier") return paramNode.left.name;
    return null;
};

export interface CallerInfo {
    file: string;
    fileContent: string;
    callNode: any;
    scope: any;
    args: any[];
    enclosingFn: EnclosingFn | null;
}

/**
 * Pulls out the function binding name from the surrounding declarator /
 * assignment so we can later match callsites by identifier. Handles four
 * common shapes seen in Vite-bundled code:
 *   const fn = (arg) => { ... }
 *   fn = (arg) => { ... }
 *   function fn(arg) { ... }
 *   { fn: (arg) => { ... } }  // object-literal property value
 */
const inferOneEnclosingFn = (fnPath: any, file: string): EnclosingFn => {
    const fnNode = fnPath.node;
    const paramNames: (string | null)[] = (fnNode.params ?? []).map(getParamName);
    const firstParamName = paramNames[0] ?? null;

    let bindingName: string | null = null;
    if (fnNode.type === "FunctionDeclaration" && fnNode.id?.type === "Identifier") {
        bindingName = fnNode.id.name;
    } else {
        const parentNode = fnPath.parentPath?.node;
        if (parentNode) {
            if (parentNode.type === "VariableDeclarator" && parentNode.id?.type === "Identifier") {
                bindingName = parentNode.id.name;
            } else if (parentNode.type === "AssignmentExpression" && parentNode.left?.type === "Identifier") {
                bindingName = parentNode.left.name;
            } else if (
                parentNode.type === "ObjectProperty" &&
                !parentNode.computed &&
                parentNode.key?.type === "Identifier"
            ) {
                bindingName = parentNode.key.name;
            }
        }
    }

    return { bindingName, firstParamName, paramNames, node: fnNode, file };
};

export const inferEnclosingFn = (callPath: any, file: string): EnclosingFn | null => {
    const fnPath = callPath.getFunctionParent();
    if (!fnPath) return null;
    const innermost = inferOneEnclosingFn(fnPath, file);
    let chainTail = innermost;
    let outerPath = fnPath.getFunctionParent();
    let depth = 0;
    while (outerPath && depth < 6) {
        const outer = inferOneEnclosingFn(outerPath, file);
        chainTail.parent = outer;
        chainTail = outer;
        outerPath = outerPath.getFunctionParent();
        depth++;
    }
    return innermost;
};

/**
 * Walks an ObjectExpression and returns the property value node for the given
 * dotted property path (e.g. ["data"] → the value node of `data: ...`).
 */
const lookupObjectExpressionProp = (objExpr: any, propPath: string[]): any => {
    if (!objExpr || objExpr.type !== "ObjectExpression") return null;
    let current: any = objExpr;
    for (const segment of propPath) {
        if (!current || current.type !== "ObjectExpression") return null;
        let next: any = null;
        for (const prop of current.properties) {
            if (prop.type !== "ObjectProperty") continue;
            const key =
                prop.key.type === "Identifier"
                    ? prop.key.name
                    : prop.key.type === "StringLiteral"
                      ? prop.key.value
                      : null;
            if (key === segment) {
                next = prop.value;
                break;
            }
        }
        if (!next) return null;
        current = next;
    }
    return current;
};

/**
 * Resolves the value of `paramName.propPath` by walking back through the
 * enclosing function's callers. If a caller's argument is itself an Identifier
 * pointing to a constant initializer, we follow that binding; if it's the
 * caller's own first parameter, we recurse to that function's callers.
 */
export const resolveParamProperty = (
    paramName: string,
    propPath: string[],
    enclosingFn: EnclosingFn | null,
    getCallers: GetCallersFn,
    depth = 0
): { node: any; scope: any; fileContent: string } | null => {
    if (!enclosingFn || depth > 6) return null;
    // Walk outward through nested anonymous callbacks until we find the fn
    // that actually declares paramName.
    let fn: EnclosingFn | null | undefined = enclosingFn;
    while (fn && (!fn.bindingName || !(fn.paramNames ?? []).includes(paramName))) {
        fn = fn.parent ?? null;
    }
    if (!fn || !fn.bindingName) return null;
    const paramIndex = (fn.paramNames ?? []).indexOf(paramName);
    if (paramIndex < 0) return null;

    const callers = getCallers(fn.bindingName, fn.file);
    if (!callers || callers.length === 0) return null;

    for (const caller of callers) {
        const arg = caller.args[paramIndex];
        if (!arg) continue;

        if (arg.type === "ObjectExpression") {
            const node = lookupObjectExpressionProp(arg, propPath);
            if (node) return { node, scope: caller.scope, fileContent: caller.fileContent };
        }

        if (arg.type === "Identifier") {
            const binding = caller.scope.getBinding(arg.name);
            const initNode = binding?.path?.node?.init;
            if (initNode && initNode.type === "ObjectExpression") {
                const node = lookupObjectExpressionProp(initNode, propPath);
                if (node) return { node, scope: caller.scope, fileContent: caller.fileContent };
            }
            if (enclosingFnChainHasParam(caller.enclosingFn, arg.name)) {
                const result = resolveParamProperty(arg.name, propPath, caller.enclosingFn, getCallers, depth + 1);
                if (result) return result;
            }
        }
    }
    return null;
};

const enclosingFnChainHasParam = (fn: EnclosingFn | null | undefined, name: string): boolean => {
    let cur: EnclosingFn | null | undefined = fn;
    while (cur) {
        if ((cur.paramNames ?? []).includes(name)) return true;
        cur = cur.parent ?? null;
    }
    return false;
};

export const enclosingFnChainHasBinding = (fn: EnclosingFn | null | undefined): boolean => {
    let cur: EnclosingFn | null | undefined = fn;
    while (cur) {
        if (cur.bindingName) return true;
        cur = cur.parent ?? null;
    }
    return false;
};

/**
 * Resolves [param:P] where P is the first param of enclosingFn — returns
 * the direct string value passed by the caller (not a property of it).
 */
const resolveFirstArg = (
    paramName: string,
    enclosingFn: EnclosingFn,
    getCallers: GetCallersFn,
    depth = 0
): string | null => {
    if (depth > 4) return null;
    let fn: EnclosingFn | null | undefined = enclosingFn;
    while (fn && (!fn.bindingName || !(fn.paramNames ?? []).includes(paramName))) {
        fn = fn.parent ?? null;
    }
    if (!fn || !fn.bindingName) return null;
    const paramIndex = (fn.paramNames ?? []).indexOf(paramName);
    if (paramIndex < 0) return null;
    const callers = getCallers(fn.bindingName, fn.file);
    for (const caller of callers) {
        const arg = caller.args[paramIndex];
        if (!arg) continue;
        const resolved = resolveNodeValue(arg, caller.scope, "", "fetch", caller.fileContent);
        if (typeof resolved === "string" && !resolved.startsWith("[") && resolved.length > 0) {
            return resolved;
        }
        if (arg.type === "Identifier") {
            const binding = caller.scope.getBinding(arg.name);
            const initNode = binding?.path?.node?.init;
            if (initNode) {
                const initResolved = resolveNodeValue(initNode, caller.scope, "", "fetch", caller.fileContent);
                if (typeof initResolved === "string" && !initResolved.startsWith("[") && initResolved.length > 0) {
                    return initResolved;
                }
            }
            if (caller.enclosingFn && enclosingFnChainHasParam(caller.enclosingFn, arg.name)) {
                const r = resolveFirstArg(arg.name, caller.enclosingFn, getCallers, depth + 1);
                if (r) return r;
            }
        }
    }
    return null;
};

/**
 * Renders an ObjectExpression as a `k1={k1}&k2={k2}` query-string fragment.
 */
const renderObjectAsQuery = (objExpr: any, scope: any, fileContent: string): string | null => {
    if (!objExpr || objExpr.type !== "ObjectExpression") return null;
    const parts: string[] = [];
    for (const prop of objExpr.properties) {
        if (prop.type !== "ObjectProperty") continue;
        const key =
            prop.key.type === "Identifier" ? prop.key.name : prop.key.type === "StringLiteral" ? prop.key.value : null;
        if (!key) continue;
        let valStr: string;
        try {
            const resolved = resolveNodeValue(prop.value, scope, "", "fetch", fileContent);
            if (resolved !== null && resolved !== undefined && !String(resolved).startsWith("[")) {
                valStr = encodeURIComponent(String(resolved));
            } else {
                valStr = `{${key}}`;
            }
        } catch {
            valStr = `{${key}}`;
        }
        parts.push(`${key}=${valStr}`);
    }
    return parts.length > 0 ? parts.join("&") : null;
};

/**
 * Returns a plain object derived from an ObjectExpression's properties.
 * Spread elements are merged when they themselves resolve to a literal object;
 * otherwise the spread is preserved as a sentinel key.
 */
export const renderObjectExpression = (
    objExpr: any,
    scope: any,
    fileContent: string
): Record<string, string> | null => {
    if (!objExpr || objExpr.type !== "ObjectExpression") return null;
    const out: Record<string, string> = {};
    for (const prop of objExpr.properties) {
        if (prop.type === "ObjectProperty") {
            const key =
                prop.key.type === "Identifier"
                    ? prop.key.name
                    : prop.key.type === "StringLiteral"
                      ? prop.key.value
                      : null;
            if (!key) continue;
            try {
                const resolved = resolveNodeValue(prop.value, scope, "", "fetch", fileContent);
                out[key] = resolved === undefined || resolved === null ? "" : String(resolved);
            } catch {
                out[key] = "";
            }
        } else if (prop.type === "SpreadElement") {
            try {
                const resolved = resolveNodeValue(prop.argument, scope, "", "fetch", fileContent);
                if (resolved && typeof resolved === "object") {
                    for (const [k, v] of Object.entries(resolved)) {
                        if (!(k in out)) out[k] = v === undefined || v === null ? "" : String(v);
                    }
                } else {
                    const chain = memberChainToString(prop.argument);
                    out[`...${chain ?? "spread"}`] = "<spread>";
                }
            } catch {
                const chain = memberChainToString(prop.argument);
                out[`...${chain ?? "spread"}`] = "<spread>";
            }
        }
    }
    return out;
};

export const renderValueNode = (node: any, scope: any, fileContent: string): string | null => {
    if (!node) return null;
    try {
        const resolved = resolveNodeValue(node, scope, "", "fetch", fileContent);
        if (resolved === null || resolved === undefined) return null;
        if (typeof resolved === "object") return null;
        const s = String(resolved);
        if (s.startsWith("[unresolved")) return null;
        return s;
    } catch {
        return null;
    }
};

/**
 * Substitutes [member:P.X], [urlsearchparams:P.X], and [param:P] markers in a
 * string by walking back to the enclosing function's caller(s).
 */
export const substituteCallerPlaceholders = (
    input: string,
    enclosingFn: EnclosingFn | null,
    getCallers: GetCallersFn
): string => {
    if (!input || !enclosingFn) return input;

    let output = input;

    output = output.replace(/\[urlsearchparams:([A-Za-z_$][\w$.]*)\]/g, (match, chain: string) => {
        const parts = chain.split(".");
        const paramName = parts[0];
        const propPath = parts.slice(1);
        const resolved = resolveParamProperty(paramName, propPath, enclosingFn, getCallers);
        if (!resolved) return match;
        const rendered = renderObjectAsQuery(resolved.node, resolved.scope, resolved.fileContent);
        return rendered ?? match;
    });

    output = output.replace(/\[member:([A-Za-z_$][\w$.]*)\]/g, (match, chain: string) => {
        const parts = chain.split(".");
        const paramName = parts[0];
        const propPath = parts.slice(1);
        const resolved = resolveParamProperty(paramName, propPath, enclosingFn, getCallers);
        if (!resolved) return match;
        const rendered = renderValueNode(resolved.node, resolved.scope, resolved.fileContent);
        return rendered ?? match;
    });

    // [param:P] — the URL/value IS the function parameter directly (not a property of it)
    output = output.replace(/\[param:([A-Za-z_$][\w$]*)\]/g, (match, paramName: string) => {
        const resolved = resolveFirstArg(paramName, enclosingFn, getCallers);
        return resolved ?? match;
    });

    return output;
};

/**
 * Substitutes placeholders in a header bag. `...P.X: <spread>` entries are
 * expanded when the corresponding caller-side value is a literal object.
 */
export const substituteCallerHeaders = (
    headers: Record<string, string>,
    enclosingFn: EnclosingFn | null,
    getCallers: GetCallersFn
): Record<string, string> => {
    if (!enclosingFn) return headers;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
        if (k.startsWith("...") && v === "<spread>") {
            const chain = k.slice(3);
            const parts = chain.split(".");
            const paramName = parts[0];
            const propPath = parts.slice(1);
            const resolved = resolveParamProperty(paramName, propPath, enclosingFn, getCallers);
            if (resolved && resolved.node.type === "ObjectExpression") {
                const obj = renderObjectExpression(resolved.node, resolved.scope, resolved.fileContent);
                if (obj) {
                    for (const [hk, hv] of Object.entries(obj)) {
                        if (!(hk in out)) out[hk] = hv;
                    }
                    continue;
                }
            }
            out[k] = v;
        } else {
            out[k] = substituteCallerPlaceholders(v, enclosingFn, getCallers);
        }
    }
    return out;
};

/**
 * Returns a getCallers function that searches the given file paths for call
 * sites of a named binding. Files are parsed on demand with a text pre-filter;
 * no ASTs are cached, so CallerInfo objects are only alive during the caller's
 * resolution pass and are then released to GC.
 *
 * Binding names with length ≤ 2 are skipped — they are minifier locals that
 * match too many call sites to be useful.
 */
/**
 * Builds a binding→alias map by scanning every file for export-style object
 * literals that rebind a function under a more meaningful key. Three patterns
 * are recognized — they cover the common webpack/Vite output shapes:
 *
 *   { aliasName: localBinding }          // direct re-export
 *   { aliasName: () => localBinding }    // webpack `a.d(b, {…})` getter export
 *   { aliasName: function () { return localBinding(arguments…) } }  // wrapper
 *
 * Each alias is recorded both ways so getCallers can look up callsites either
 * by the local binding or by the externally-visible export name. Computed
 * only once and cached on first access.
 */
const buildAliasMap = (filePaths: string[]): Map<string, Map<string, Set<string>>> => {
    // file -> bindingName -> set of aliases observed in that file
    const aliasesByFile = new Map<string, Map<string, Set<string>>>();
    const addAlias = (file: string, binding: string, alias: string) => {
        if (!binding || !alias || binding === alias) return;
        let perFile = aliasesByFile.get(file);
        if (!perFile) {
            perFile = new Map();
            aliasesByFile.set(file, perFile);
        }
        let set = perFile.get(binding);
        if (!set) {
            set = new Set();
            perFile.set(binding, set);
        }
        set.add(alias);
    };

    for (const filePath of filePaths) {
        let fileContent: string;
        try {
            fileContent = fs.readFileSync(filePath, "utf-8");
        } catch {
            continue;
        }
        let fileAst: any;
        try {
            fileAst = parser.parse(fileContent, {
                sourceType: "unambiguous",
                plugins: ["jsx", "typescript"],
                errorRecovery: true,
            });
        } catch {
            continue;
        }
        traverse(fileAst, {
            ObjectProperty(propPath: any) {
                const node = propPath.node;
                if (node.computed) return;
                const key =
                    node.key.type === "Identifier"
                        ? node.key.name
                        : node.key.type === "StringLiteral"
                          ? node.key.value
                          : null;
                if (!key) return;
                const val = node.value;
                if (val.type === "Identifier") {
                    addAlias(filePath, val.name, key);
                } else if (
                    val.type === "ArrowFunctionExpression" &&
                    val.params.length === 0 &&
                    val.body.type === "Identifier"
                ) {
                    // `key: () => Binding` (webpack getter export)
                    addAlias(filePath, val.body.name, key);
                }
            },
        });
    }
    return aliasesByFile;
};

export type GetCallersFn = (bindingName: string, sourceFile?: string) => CallerInfo[];

// Per-instance cache of (content, AST) tuples keyed by file path. Avoids
// re-reading and re-parsing every JS file on every getCallers call — the
// dominant cost at high recursion depth.
interface FileCacheEntry {
    content: string;
    ast: any | null;
}
const loadFileCached = (filePath: string, cache: Map<string, FileCacheEntry | null>): FileCacheEntry | null => {
    if (cache.has(filePath)) return cache.get(filePath) ?? null;
    let content: string;
    try {
        content = fs.readFileSync(filePath, "utf-8");
    } catch {
        cache.set(filePath, null);
        return null;
    }
    let ast: any = null;
    try {
        ast = parser.parse(content, {
            sourceType: "unambiguous",
            plugins: ["jsx", "typescript"],
            errorRecovery: true,
        });
    } catch {
        ast = null;
    }
    const entry: FileCacheEntry = { content, ast };
    cache.set(filePath, entry);
    return entry;
};

export const makeGetCallers = (filePaths: string[], maxCallers = 128): GetCallersFn => {
    let aliasMap: Map<string, Map<string, Set<string>>> | null = null;
    const fileCache = new Map<string, FileCacheEntry | null>();
    return (bindingName: string, sourceFile?: string): CallerInfo[] => {
        if (!bindingName) return [];
        if (aliasMap === null) aliasMap = buildAliasMap(filePaths);
        // Use only the aliases defined in the file where `bindingName` lives;
        // otherwise minifier name collisions across modules (`Se` may name
        // different functions in different files) pollute the alias set.
        const aliases = (sourceFile && aliasMap.get(sourceFile)?.get(bindingName)) || new Set<string>();
        // Only match by names that are long enough to be distinctive. Short
        // minifier locals (≤ 2 chars) alone match too many sites; longer
        // alias names — usually the exported function names — are safe.
        const candidates = new Set<string>([bindingName, ...aliases].filter((n) => n.length > 2));
        if (candidates.size === 0) return [];
        const needles = Array.from(candidates).map((n) => `${n}(`);
        const out: CallerInfo[] = [];
        let overflowed = false;
        for (const filePath of filePaths) {
            if (overflowed) break;
            const cached = loadFileCached(filePath, fileCache);
            if (!cached) continue;
            const fileContent = cached.content;
            if (!needles.some((n) => fileContent.includes(n))) continue;
            const fileAst = cached.ast;
            if (!fileAst) continue;
            traverse(fileAst, {
                CallExpression(callPath: any) {
                    if (overflowed) {
                        callPath.stop();
                        return;
                    }
                    const callee = callPath.node.callee;
                    const isDirect = callee.type === "Identifier" && candidates.has(callee.name);
                    // Registry-style exports re-bind functions onto an object
                    // (e.g. `const ae = { request: Me }; ae.request(...)`), so we
                    // accept member-expression callsites where the property name
                    // matches the binding (or one of its aliases) too.
                    const isMember =
                        callee.type === "MemberExpression" &&
                        !callee.computed &&
                        callee.property.type === "Identifier" &&
                        candidates.has(callee.property.name);
                    if (!isDirect && !isMember) return;
                    if (out.length >= maxCallers) {
                        overflowed = true;
                        callPath.stop();
                        return;
                    }
                    out.push({
                        file: filePath,
                        fileContent,
                        callNode: callPath.node,
                        scope: callPath.scope,
                        args: callPath.node.arguments,
                        enclosingFn: inferEnclosingFn(callPath, filePath),
                    });
                },
            });
        }
        // On overflow keep the callers we already collected: the alias map is
        // file-scoped so an oversized result usually reflects a genuinely
        // popular wrapper, and partial coverage beats none.
        return out;
    };
};

/**
 * Like makeGetCallers but searches only the source file and does NOT filter by
 * name length. Used as a fallback for body-param resolution when the binding is
 * a short minifier local (e.g. `O`) and the caller in the same file uses the
 * raw name rather than an exported alias.
 *
 * Never call this for URL fan-out — the short-name matches are file-scoped and
 * won't flood cross-file call graphs.
 */
export const makeGetCallersSameFile = (): GetCallersFn => {
    return (bindingName: string, sourceFile?: string): CallerInfo[] => {
        if (!bindingName || !sourceFile) return [];
        let fileContent: string;
        try {
            fileContent = fs.readFileSync(sourceFile, "utf-8");
        } catch {
            return [];
        }
        if (!fileContent.includes(`${bindingName}(`)) return [];
        let fileAst: any;
        try {
            fileAst = parser.parse(fileContent, {
                sourceType: "unambiguous",
                plugins: ["jsx", "typescript"],
                errorRecovery: true,
            });
        } catch {
            return [];
        }
        const out: CallerInfo[] = [];
        traverse(fileAst, {
            CallExpression(callPath: any) {
                const callee = callPath.node.callee;
                if (callee.type !== "Identifier" || callee.name !== bindingName) return;
                if (out.length >= 32) {
                    callPath.stop();
                    return;
                }
                out.push({
                    file: sourceFile,
                    fileContent,
                    callNode: callPath.node,
                    scope: callPath.scope,
                    args: callPath.node.arguments,
                    enclosingFn: inferEnclosingFn(callPath, sourceFile),
                });
            },
        });
        return out;
    };
};
