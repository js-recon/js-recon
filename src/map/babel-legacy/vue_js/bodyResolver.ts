import { resolveNodeValue, memberChainToString } from "../next_js/utils.js";
import type { EnclosingFn, GetCallersFn } from "./taint_utils.js";
import { substituteCallerPlaceholders, makeGetCallersSameFile } from "./taint_utils.js";

const _sameFileGetCallers = makeGetCallersSameFile();

/**
 * Deep AST-based resolver for body/payload nodes. Walks an expression and
 * produces a JS value (object / array / string / placeholder marker).
 *
 * The motivation: `resolveNodeValue` emits opaque `[call:NAME()]` markers
 * whenever a value comes from a CallExpression. In webpack output the body is
 * frequently produced by a thin local builder function that just forwards one
 * of its parameters (e.g. `f(e,t,n,l) { const p = {body: l || {}, …}; return
 * (…, p.body); }`). Inlining that call recovers the parameter reference so
 * later taint analysis can chase it across wrapper boundaries.
 *
 * Pattern coverage targeted by this resolver:
 *   - Local function call whose return traces to one of its parameters
 *     (directly, through `param || default`, through `localVar.prop` where
 *     `localVar = { prop: param || … }`, or through a SequenceExpression's
 *     last value).
 *   - ObjectExpression / ArrayExpression literal nesting.
 *   - Logical `||` (prefer LHS marker, fall back to RHS literal).
 *   - Identifier indirection via `binding.init`.
 *   - MemberExpression where the base is a local object literal binding.
 */

const PLACEHOLDER_RE = /^\[(unresolved|call|member|param|var |MemberExpression)/;

const isUnresolvedString = (v: any): boolean => typeof v === "string" && PLACEHOLDER_RE.test(v);

const isResolvedLiteralString = (v: any): boolean => typeof v === "string" && v.length > 0 && !PLACEHOLDER_RE.test(v);

const getPropKey = (prop: any): string | null => {
    if (prop.computed) return null;
    if (prop.key.type === "Identifier") return prop.key.name;
    if (prop.key.type === "StringLiteral") return prop.key.value;
    return null;
};

const getFunctionFromBinding = (binding: any): any | null => {
    if (!binding?.path?.node) return null;
    const n = binding.path.node;
    if (n.type === "FunctionDeclaration") return n;
    if (n.type === "VariableDeclarator" && n.init) {
        const init = n.init;
        if (
            init.type === "FunctionExpression" ||
            init.type === "ArrowFunctionExpression" ||
            init.type === "FunctionDeclaration"
        ) {
            return init;
        }
    }
    return null;
};

const getReturnExpression = (fnNode: any): any | null => {
    const body = fnNode.body;
    if (!body) return null;
    if (body.type !== "BlockStatement") return body;
    for (let i = body.body.length - 1; i >= 0; i--) {
        const s = body.body[i];
        if (s.type === "ReturnStatement" && s.argument) return s.argument;
    }
    return null;
};

export const deepResolveValue = (node: any, scope: any, fileContent: string, depth = 0): any => {
    if (!node) return null;
    if (depth > 8) return resolveNodeValue(node, scope, "", "fetch", fileContent);

    switch (node.type) {
        case "StringLiteral":
        case "NumericLiteral":
        case "BooleanLiteral":
            return node.value;
        case "NullLiteral":
            return null;
        case "TemplateLiteral":
            return resolveNodeValue(node, scope, "", "fetch", fileContent);

        case "ObjectExpression": {
            const out: Record<string, any> = {};
            for (const prop of node.properties) {
                if (prop.type === "ObjectProperty") {
                    const key = getPropKey(prop);
                    if (!key) continue;
                    out[key] = deepResolveValue(prop.value, scope, fileContent, depth + 1);
                } else if (prop.type === "SpreadElement") {
                    const sub = deepResolveValue(prop.argument, scope, fileContent, depth + 1);
                    if (sub && typeof sub === "object" && !Array.isArray(sub)) {
                        for (const [k, v] of Object.entries(sub)) {
                            if (!(k in out)) out[k] = v;
                        }
                    } else {
                        const chain = memberChainToString(prop.argument);
                        out[`...${chain ?? "spread"}`] = "<spread>";
                    }
                }
            }
            return out;
        }

        case "ArrayExpression":
            return node.elements.map((e: any) => (e ? deepResolveValue(e, scope, fileContent, depth + 1) : null));

        case "LogicalExpression": {
            // For `a || b` we prefer the LHS — even if it resolves to a
            // `[param:X]` marker. Runtime would pick LHS when truthy; statically
            // the LHS is the value we'd want taint analysis to chase. Only when
            // LHS is fully `null` / `undefined` do we look at RHS.
            const left = deepResolveValue(node.left, scope, fileContent, depth + 1);
            if (node.operator === "||") {
                if (left === null || left === undefined) {
                    return deepResolveValue(node.right, scope, fileContent, depth + 1);
                }
                return left;
            }
            if (node.operator === "&&") {
                return deepResolveValue(node.right, scope, fileContent, depth + 1);
            }
            if (node.operator === "??") {
                if (left === null || left === undefined) {
                    return deepResolveValue(node.right, scope, fileContent, depth + 1);
                }
                return left;
            }
            return left;
        }

        case "ConditionalExpression": {
            const c = deepResolveValue(node.consequent, scope, fileContent, depth + 1);
            if (c !== null && c !== undefined && !isUnresolvedString(c)) return c;
            return deepResolveValue(node.alternate, scope, fileContent, depth + 1);
        }

        case "SequenceExpression":
            return deepResolveValue(node.expressions[node.expressions.length - 1], scope, fileContent, depth + 1);

        case "ParenthesizedExpression":
            return deepResolveValue((node as any).expression, scope, fileContent, depth + 1);

        case "Identifier": {
            // Prefer following the binding's init ourselves — `resolveNodeValue`
            // also follows it, but its ObjectExpression branch handles nested
            // CallExpressions by emitting opaque `[call:NAME()]` markers, with
            // no opportunity to inline them. By recursing through
            // `deepResolveValue` we keep the structure and pick up local
            // function inlining for each leaf.
            try {
                const binding = scope?.getBinding?.(node.name);
                const init = binding?.path?.node?.init;
                if (
                    init &&
                    (init.type === "ObjectExpression" ||
                        init.type === "ArrayExpression" ||
                        init.type === "CallExpression" ||
                        init.type === "LogicalExpression" ||
                        init.type === "ConditionalExpression" ||
                        init.type === "MemberExpression" ||
                        init.type === "Identifier")
                ) {
                    return deepResolveValue(init, binding.scope ?? scope, fileContent, depth + 1);
                }
            } catch {}
            return resolveNodeValue(node, scope, "", "fetch", fileContent);
        }

        case "OptionalMemberExpression":
        case "MemberExpression": {
            // Try resolving the whole member chain via a local object literal:
            //   const p = { body: X, … }; return p.body  →  X
            if (!node.computed && node.property.type === "Identifier" && node.object.type === "Identifier") {
                try {
                    const binding = scope?.getBinding?.(node.object.name);
                    const init = binding?.path?.node?.init;
                    if (init && init.type === "ObjectExpression") {
                        for (const prop of init.properties) {
                            if (prop.type !== "ObjectProperty") continue;
                            if (getPropKey(prop) === node.property.name) {
                                return deepResolveValue(prop.value, binding.scope ?? scope, fileContent, depth + 1);
                            }
                        }
                    }
                } catch {}
            }
            // Fall back to the generic resolver (emits `[member:a.b]`).
            return resolveNodeValue(node, scope, "", "fetch", fileContent);
        }

        case "CallExpression": {
            const inlined = inlineLocalCall(node, scope, fileContent, depth);
            if (inlined !== undefined) return inlined;
            return resolveNodeValue(node, scope, "", "fetch", fileContent);
        }

        case "AwaitExpression":
            return deepResolveValue((node as any).argument, scope, fileContent, depth + 1);

        default:
            return resolveNodeValue(node, scope, "", "fetch", fileContent);
    }
};

/**
 * Attempts to inline a CallExpression to a local function defined in the same
 * file. Returns `undefined` to signal "fall back to opaque marker"; any other
 * value (including `null`) is treated as a resolved result.
 *
 * The caller's scope is needed to resolve the arguments passed in; the
 * function's own scope is needed to resolve any local bindings referenced
 * inside its return expression.
 */
const inlineLocalCall = (callNode: any, callerScope: any, fileContent: string, depth: number): any => {
    if (callNode.callee.type !== "Identifier") return undefined;
    const fnName = callNode.callee.name;
    let binding: any;
    try {
        binding = callerScope?.getBinding?.(fnName);
    } catch {
        return undefined;
    }
    if (!binding) return undefined;
    const fnNode = getFunctionFromBinding(binding);
    if (!fnNode) return undefined;

    const params: (string | null)[] = (fnNode.params || []).map((p: any) =>
        p?.type === "Identifier"
            ? p.name
            : p?.type === "AssignmentPattern" && p.left?.type === "Identifier"
              ? p.left.name
              : null
    );
    const args = callNode.arguments || [];

    const returnExpr = getReturnExpression(fnNode);
    if (!returnExpr) return undefined;

    const fnScope = binding.path?.get?.("body")?.scope ?? binding.scope ?? callerScope;
    return resolveReturnInline(returnExpr, params, args, fnScope, callerScope, fileContent, depth + 1);
};

const resolveReturnInline = (
    node: any,
    params: (string | null)[],
    args: any[],
    fnScope: any,
    callerScope: any,
    fileContent: string,
    depth: number
): any => {
    if (!node) return undefined;
    if (depth > 10) return undefined;

    switch (node.type) {
        case "Identifier": {
            const idx = params.indexOf(node.name);
            if (idx >= 0 && idx < args.length && args[idx]) {
                return deepResolveValue(args[idx], callerScope, fileContent, depth);
            }
            // Local binding inside the function; resolve in fnScope.
            return deepResolveValue(node, fnScope, fileContent, depth);
        }
        case "SequenceExpression":
            return resolveReturnInline(
                node.expressions[node.expressions.length - 1],
                params,
                args,
                fnScope,
                callerScope,
                fileContent,
                depth + 1
            );
        case "LogicalExpression": {
            const l = resolveReturnInline(node.left, params, args, fnScope, callerScope, fileContent, depth + 1);
            if (node.operator === "||" || node.operator === "??") {
                if (l === null || l === undefined) {
                    return resolveReturnInline(node.right, params, args, fnScope, callerScope, fileContent, depth + 1);
                }
                return l;
            }
            if (node.operator === "&&") {
                return resolveReturnInline(node.right, params, args, fnScope, callerScope, fileContent, depth + 1);
            }
            return l;
        }
        case "ConditionalExpression": {
            const c = resolveReturnInline(node.consequent, params, args, fnScope, callerScope, fileContent, depth + 1);
            if (c !== null && c !== undefined && !isUnresolvedString(c)) return c;
            return resolveReturnInline(node.alternate, params, args, fnScope, callerScope, fileContent, depth + 1);
        }
        case "OptionalMemberExpression":
        case "MemberExpression": {
            // Look up `local.prop` where `local` is bound to an ObjectExpression
            // inside the function — common builder pattern.
            if (!node.computed && node.object.type === "Identifier" && node.property.type === "Identifier") {
                try {
                    const localBinding = fnScope?.getBinding?.(node.object.name);
                    const init = localBinding?.path?.node?.init;
                    if (init && init.type === "ObjectExpression") {
                        for (const prop of init.properties) {
                            if (prop.type !== "ObjectProperty") continue;
                            if (getPropKey(prop) === node.property.name) {
                                return resolveReturnInline(
                                    prop.value,
                                    params,
                                    args,
                                    localBinding.scope ?? fnScope,
                                    callerScope,
                                    fileContent,
                                    depth + 1
                                );
                            }
                        }
                    }
                } catch {}
            }
            return deepResolveValue(node, fnScope, fileContent, depth);
        }
        case "ObjectExpression": {
            const out: Record<string, any> = {};
            for (const prop of node.properties) {
                if (prop.type === "ObjectProperty") {
                    const key = getPropKey(prop);
                    if (!key) continue;
                    out[key] = resolveReturnInline(
                        prop.value,
                        params,
                        args,
                        fnScope,
                        callerScope,
                        fileContent,
                        depth + 1
                    );
                } else if (prop.type === "SpreadElement") {
                    const sub = resolveReturnInline(
                        prop.argument,
                        params,
                        args,
                        fnScope,
                        callerScope,
                        fileContent,
                        depth + 1
                    );
                    if (sub && typeof sub === "object" && !Array.isArray(sub)) {
                        for (const [k, v] of Object.entries(sub)) {
                            if (!(k in out)) out[k] = v;
                        }
                    }
                }
            }
            return out;
        }
        case "ArrayExpression":
            return node.elements.map((e: any) =>
                e ? resolveReturnInline(e, params, args, fnScope, callerScope, fileContent, depth + 1) : null
            );
        case "CallExpression": {
            // Recurse: the return might itself be a call to another local helper.
            const inlined = inlineLocalCall(node, fnScope, fileContent, depth + 1);
            if (inlined !== undefined) return inlined;
            return deepResolveValue(node, fnScope, fileContent, depth);
        }
        default:
            return deepResolveValue(node, fnScope, fileContent, depth);
    }
};

/**
 * Walks a resolved value (object/array/string) and applies a string-rewriter to
 * every leaf string. Used so the existing taint-substitution helpers can be
 * applied to every nested marker inside a deeply-resolved body without having
 * to teach them about object structure.
 */
export const mapLeafStrings = (value: any, fn: (s: string) => string): any => {
    if (value === null || value === undefined) return value;
    if (typeof value === "string") return fn(value);
    if (Array.isArray(value)) return value.map((v) => mapLeafStrings(v, fn));
    if (typeof value === "object") {
        const out: Record<string, any> = {};
        for (const [k, v] of Object.entries(value)) out[k] = mapLeafStrings(v, fn);
        return out;
    }
    return value;
};

/**
 * Returns true if any leaf string in the value contains a placeholder marker
 * that taint analysis can substitute.
 */
export const hasMarkers = (value: any): boolean => {
    if (value === null || value === undefined) return false;
    if (typeof value === "string") return /\[(urlsearchparams|member|param|call):/.test(value);
    if (Array.isArray(value)) return value.some((v) => hasMarkers(v));
    if (typeof value === "object") {
        for (const v of Object.values(value)) if (hasMarkers(v)) return true;
    }
    return false;
};

/**
 * Like resolveFirstArg in taint_utils but returns any JS value — objects,
 * arrays, or scalars — so callers can substitute a [param:X] body leaf with
 * the full structured value that was passed at the call site.
 *
 * Placed here (not in taint_utils) to avoid a circular import:
 * taint_utils → (nothing from bodyResolver); bodyResolver → taint_utils types only.
 */
// Returns true if value contains at least one concrete literal (non-marker) leaf.
// Used to skip caller results where every value is still an unresolved placeholder.
const hasRealValue = (v: any): boolean => {
    if (v === null || v === undefined) return false;
    if (typeof v === "number" || typeof v === "boolean") return true;
    if (typeof v === "string") return v.length > 0 && !v.startsWith("[");
    if (Array.isArray(v)) return v.some(hasRealValue);
    if (typeof v === "object") return Object.values(v).some(hasRealValue);
    return true;
};

export const resolveParamToAnyValue = (
    paramName: string,
    enclosingFn: EnclosingFn,
    getCallers: GetCallersFn,
    depth = 0
): any => {
    if (depth > 4) return null;
    let fn: EnclosingFn | null | undefined = enclosingFn;
    while (fn && (!fn.bindingName || !(fn.paramNames ?? []).includes(paramName))) {
        fn = fn.parent ?? null;
    }
    if (!fn || !fn.bindingName) return null;
    const paramIndex = (fn.paramNames ?? []).indexOf(paramName);
    if (paramIndex < 0) return null;
    const searchCallers = (callerList: ReturnType<typeof getCallers>): { obj: any; str: any } => {
        let firstObj: any = undefined;
        let firstStr: any = undefined;
        for (const caller of callerList) {
            const arg = caller.args[paramIndex];
            if (!arg) continue;
            const resolved = deepResolveValue(arg, caller.scope, caller.fileContent);
            if (resolved === null || resolved === undefined) continue;
            if (!hasRealValue(resolved)) continue;
            if (typeof resolved === "object" && firstObj === undefined) firstObj = resolved;
            if (typeof resolved !== "object" && firstStr === undefined) firstStr = resolved;
            if (firstObj !== undefined && firstStr !== undefined) break;
        }
        return { obj: firstObj, str: firstStr };
    };

    const { obj, str } = searchCallers(getCallers(fn.bindingName, fn.file));
    if (obj !== undefined) return obj;

    // Fallback for short binding names: makeGetCallers skips them to avoid
    // cross-file false positives, but same-file direct calls are unambiguous.
    if (fn.bindingName.length <= 2 && fn.file) {
        const { obj: sameObj, str: sameStr } = searchCallers(_sameFileGetCallers(fn.bindingName, fn.file));
        if (sameObj !== undefined) return sameObj;
        if (str === undefined && sameStr !== undefined) return sameStr;
    }

    return str ?? null;
};

/**
 * Recursively walks a resolved value (object/array/string). When a leaf
 * string is a bare [param:name] placeholder, tries resolveParamToAnyValue
 * first so a caller-side ObjectExpression is returned as a real nested object
 * rather than a string. Falls back to substituteCallerPlaceholders for
 * non-param and composite markers.
 *
 * Exported so both the HTTP-client resolver and the fetch resolver can use it
 * without duplicating the logic.
 */
export const deepSubstituteBodyValue = (value: any, enclosingFn: EnclosingFn | null, getCallers: GetCallersFn): any => {
    if (value === null || value === undefined) return value;
    if (typeof value === "string") {
        const m = value.match(/^\[param:([A-Za-z_$][\w$]*)\]$/);
        if (m && enclosingFn) {
            const resolved = resolveParamToAnyValue(m[1], enclosingFn, getCallers);
            if (resolved !== null && resolved !== undefined) return resolved;
        }
        return substituteCallerPlaceholders(value, enclosingFn, getCallers);
    }
    if (Array.isArray(value)) return value.map((v) => deepSubstituteBodyValue(v, enclosingFn, getCallers));
    if (typeof value === "object") {
        const out: Record<string, any> = {};
        for (const [k, v] of Object.entries(value)) {
            out[k] = deepSubstituteBodyValue(v, enclosingFn, getCallers);
        }
        return out;
    }
    return value;
};
