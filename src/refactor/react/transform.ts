import { NodePath } from "@babel/traverse";
import traverse from "@babel/traverse";
import generate from "@babel/generator";
import * as t from "@babel/types";
import {
    tryExtractModuleExportsAssignment,
    tryExtractExportsAssignment,
    tryExtractRequireCall,
    buildModuleExportStatement,
    makeNamedExportStatement,
} from "./helpers.js";
import {
    LibraryModuleInfo,
    LibraryType,
    REACT_CANONICAL,
    JSX_RUNTIME_CANONICAL,
    REACT_DOM_CLIENT_CANONICAL,
    REACT_ROUTER_DOM_CANONICAL,
    librarySource,
} from "./library-classify.js";

export type ModuleEntry = {
    id: string;
    fnPath: NodePath<t.FunctionExpression | t.ArrowFunctionExpression> | NodePath<t.ObjectMethod>;
    paramCount: number;
    moduleParam: string;
    exportsParam: string;
    requireParam: string | undefined;
};

/**
 * Transforms a single webpack module function into an array of ES module statements.
 *
 * Four passes (all top-level only to avoid placing exports inside nested functions):
 *   1. `<moduleParam>.exports = <rhs>` → `export * from` or `export default`
 *   2. `<exportsParam>.<prop> = <rhs>` → named export (all modules with an exportsParam)
 *   3. Hoist `var x = <requireParam>(N)` to static `import * as x from "./N.js"`
 *   4. Replace remaining inline `<requireParam>(N)` calls with the hoisted name
 */
export const transformModule = (mod: ModuleEntry): t.Statement[] => {
    const { fnPath, moduleParam, exportsParam, requireParam } = mod;
    const body = fnPath.node.body;
    if (!t.isBlockStatement(body)) return [];

    // Pass 1 — handle `<moduleParam>.exports = <rhs>` at the top level only.
    if (moduleParam) {
        const next: t.Statement[] = [];
        for (const stmt of body.body) {
            if (!t.isExpressionStatement(stmt)) {
                next.push(stmt);
                continue;
            }
            const expr = stmt.expression;

            const directRhs = tryExtractModuleExportsAssignment(expr, moduleParam);
            if (directRhs) {
                next.push(buildModuleExportStatement(directRhs, requireParam));
                continue;
            }

            if (t.isSequenceExpression(expr)) {
                let hadMatch = false;
                const splitted: t.Statement[] = [];
                for (const sub of expr.expressions) {
                    const rhs = tryExtractModuleExportsAssignment(sub, moduleParam);
                    if (rhs) {
                        hadMatch = true;
                        splitted.push(buildModuleExportStatement(rhs, requireParam));
                    } else {
                        splitted.push(t.expressionStatement(sub as t.Expression));
                    }
                }
                if (hadMatch) {
                    next.push(...splitted);
                    continue;
                }
            }
            next.push(stmt);
        }
        body.body = next;
    }

    // Pass 1.5 — handle webpack ES module registration patterns:
    //   `<requireParam>.r(<exportsParam>)` → drop (marks module as ES module, not needed in ESM)
    //   `<requireParam>.d(<exportsParam>, {name: ()=>binding, ...})` → named exports
    // This handles the common lazy-chunk pattern where webpack emits r.r(t), r.d(t, {default:()=>X})
    // at the top of the module body instead of the older t.exports = X form.
    if (requireParam && exportsParam) {
        const processWebpackRegExpr = (expr: t.Expression): t.Statement[] | null => {
            if (!t.isCallExpression(expr)) return null;
            const callee = expr.callee;
            if (!t.isMemberExpression(callee) || callee.computed) return null;
            if (!t.isIdentifier(callee.object, { name: requireParam })) return null;
            const method = t.isIdentifier(callee.property) ? (callee.property as t.Identifier).name : null;
            if (!method) return null;

            // r.r(t) → drop
            if (
                method === "r" &&
                expr.arguments.length === 1 &&
                t.isIdentifier(expr.arguments[0], { name: exportsParam })
            ) {
                return [];
            }

            // r.d(t, {name: ()=>binding, ...}) → named export statements
            if (
                method === "d" &&
                expr.arguments.length >= 2 &&
                t.isIdentifier(expr.arguments[0], { name: exportsParam }) &&
                t.isObjectExpression(expr.arguments[1])
            ) {
                const stmts: t.Statement[] = [];
                for (const prop of (expr.arguments[1] as t.ObjectExpression).properties) {
                    if (!t.isObjectProperty(prop) || prop.computed) continue;
                    const key = prop.key;
                    const val = prop.value as t.Expression;
                    let propName: string | null = null;
                    if (t.isIdentifier(key)) propName = (key as t.Identifier).name;
                    else if (t.isStringLiteral(key)) propName = (key as t.StringLiteral).value;
                    if (!propName) continue;
                    // val is typically `() => binding` — unwrap the arrow function body
                    const exportedVal =
                        t.isArrowFunctionExpression(val) && !t.isBlockStatement(val.body)
                            ? (val.body as t.Expression)
                            : val;
                    stmts.push(makeNamedExportStatement(propName, exportedVal));
                }
                return stmts;
            }

            return null;
        };

        const next: t.Statement[] = [];
        for (const stmt of body.body) {
            if (!t.isExpressionStatement(stmt)) {
                next.push(stmt);
                continue;
            }
            const expr = stmt.expression;

            if (t.isSequenceExpression(expr)) {
                let hadMatch = false;
                const splitted: t.Statement[] = [];
                for (const sub of expr.expressions) {
                    const handled = processWebpackRegExpr(sub as t.Expression);
                    if (handled !== null) {
                        hadMatch = true;
                        splitted.push(...handled);
                    } else {
                        splitted.push(t.expressionStatement(sub as t.Expression));
                    }
                }
                if (hadMatch) {
                    next.push(...splitted);
                    continue;
                }
            }

            const handled = processWebpackRegExpr(expr);
            if (handled !== null) {
                next.push(...handled);
            } else {
                next.push(stmt);
            }
        }
        body.body = next;
    }

    // Pass 2 — handle `<exportsParam>.<propName> = <rhs>` at the top level only.
    if (exportsParam) {
        const next: t.Statement[] = [];
        for (const stmt of body.body) {
            if (!t.isExpressionStatement(stmt)) {
                next.push(stmt);
                continue;
            }
            const expr = stmt.expression;

            const direct = tryExtractExportsAssignment(expr, exportsParam);
            if (direct) {
                next.push(makeNamedExportStatement(direct.propName, direct.rhs));
                continue;
            }

            if (t.isSequenceExpression(expr)) {
                const splitted: t.Statement[] = [];
                for (const sub of expr.expressions) {
                    const match = tryExtractExportsAssignment(sub, exportsParam);
                    if (match) {
                        splitted.push(makeNamedExportStatement(match.propName, match.rhs));
                    } else {
                        splitted.push(t.expressionStatement(sub as t.Expression));
                    }
                }
                next.push(...splitted);
                continue;
            }
            next.push(stmt);
        }
        body.body = next;
    }

    // Pass 3 — hoist top-level `var <name> = <requireParam>(N)` to static imports.
    // moduleSpec → importName
    const hoistedImports = new Map<string, string>();
    // numId → canonical importName (used by Pass 4 for inline replacements)
    const importNameByNumId = new Map<number, string>();

    if (requireParam) {
        const next: t.Statement[] = [];
        for (const stmt of body.body) {
            if (!t.isVariableDeclaration(stmt)) {
                next.push(stmt);
                continue;
            }
            const kept: t.VariableDeclarator[] = [];
            for (const decl of stmt.declarations) {
                if (!t.isIdentifier(decl.id) || !decl.init) {
                    kept.push(decl);
                    continue;
                }
                const numId = tryExtractRequireCall(decl.init, requireParam);
                if (numId === null) {
                    kept.push(decl);
                    continue;
                }
                const spec = `./${numId}.js`;
                if (!hoistedImports.has(spec)) {
                    hoistedImports.set(spec, decl.id.name);
                    importNameByNumId.set(numId, decl.id.name);
                }
                // declarator removed (it becomes the static import)
            }
            if (kept.length > 0) {
                next.push(t.variableDeclaration(stmt.kind, kept));
            }
        }
        body.body = next;
    }

    // Pass 4 — replace any remaining inline `<requireParam>(N)` calls with a synthesized
    // namespace import reference.
    if (requireParam) {
        fnPath.traverse({
            CallExpression(p) {
                const numId = tryExtractRequireCall(p.node, requireParam);
                if (numId === null) return;
                let name = importNameByNumId.get(numId);
                if (!name) {
                    name = `_jsr_module_${numId}`;
                    hoistedImports.set(`./${numId}.js`, name);
                    importNameByNumId.set(numId, name);
                }
                p.replaceWith(t.identifier(name));
                p.skip();
            },
        });
    }

    // Pass 4.5 — convert webpack async chunk loading to a true dynamic import:
    //   requireParam.e(N).then(requireParam.bind(requireParam, N)) → import('./N.js')
    // This pattern is emitted by webpack for React.lazy() code-split points. After the
    // outer module wrapper is stripped, `requireParam` is no longer in scope, so the
    // expression must be replaced before Step 5 removes it.
    if (requireParam) {
        fnPath.traverse({
            CallExpression(callPath) {
                const node = callPath.node;
                // Outer call must be X.then(bindExpr) — non-computed member
                if (!t.isMemberExpression(node.callee) || (node.callee as t.MemberExpression).computed) return;
                if (!t.isIdentifier((node.callee as t.MemberExpression).property, { name: "then" })) return;
                // X must be requireParam.e(numId)
                const eCallNode = (node.callee as t.MemberExpression).object;
                if (!t.isCallExpression(eCallNode)) return;
                const eCallee = (eCallNode as t.CallExpression).callee;
                if (!t.isMemberExpression(eCallee) || (eCallee as t.MemberExpression).computed) return;
                if (!t.isIdentifier((eCallee as t.MemberExpression).object, { name: requireParam })) return;
                if (!t.isIdentifier((eCallee as t.MemberExpression).property, { name: "e" })) return;
                const eArgs = (eCallNode as t.CallExpression).arguments;
                if (eArgs.length !== 1 || !t.isNumericLiteral(eArgs[0])) return;
                const numId = (eArgs[0] as t.NumericLiteral).value;
                // The .then() argument must be requireParam.bind(requireParam, numId)
                if (node.arguments.length !== 1 || !t.isCallExpression(node.arguments[0])) return;
                const bindNode = node.arguments[0] as t.CallExpression;
                if (!t.isMemberExpression(bindNode.callee) || (bindNode.callee as t.MemberExpression).computed) return;
                if (!t.isIdentifier((bindNode.callee as t.MemberExpression).object, { name: requireParam })) return;
                if (!t.isIdentifier((bindNode.callee as t.MemberExpression).property, { name: "bind" })) return;
                const bindArgs = bindNode.arguments;
                if (bindArgs.length !== 2) return;
                if (!t.isIdentifier(bindArgs[0], { name: requireParam })) return;
                if (!t.isNumericLiteral(bindArgs[1]) || (bindArgs[1] as t.NumericLiteral).value !== numId) return;
                // Replace with import('./N.js') — an ImportExpression node (Babel 8 shape)
                callPath.replaceWith(t.importExpression(t.stringLiteral(`./${numId}.js`)));
                callPath.skip();
            },
        });
    }

    // Step 5 — strip outer function wrapper, prepend hoisted static imports.
    const importStmts: t.Statement[] = [];
    for (const [spec, name] of hoistedImports) {
        importStmts.push(t.importDeclaration([t.importNamespaceSpecifier(t.identifier(name))], t.stringLiteral(spec)));
    }

    return [...importStmts, ...body.body];
};

// Returns true when fn matches the webpack runtime require helper:
//   function X(id) { … return (moduleMap[id](mod, mod.exports, X), mod.exports); }
// The key signal is the final return statement: a SequenceExpression whose first element
// is a computed-member CallExpression and whose second is a `<var>.exports` MemberExpression.
const isWebpackRequireHelper = (fn: t.FunctionDeclaration): boolean => {
    if (fn.params.length !== 1) return false;
    for (const stmt of fn.body.body) {
        if (!t.isReturnStatement(stmt) || !stmt.argument) continue;
        const arg = stmt.argument;
        if (!t.isSequenceExpression(arg) || arg.expressions.length !== 2) continue;
        const [first, second] = arg.expressions;
        if (!t.isCallExpression(first)) continue;
        if (!t.isMemberExpression(first.callee) || !(first.callee as t.MemberExpression).computed) continue;
        if (!t.isMemberExpression(second)) continue;
        if (!t.isIdentifier((second as t.MemberExpression).property, { name: "exports" })) continue;
        return true;
    }
    return false;
};

// ---------------------------------------------------------------------------
// Pass D helpers — library-aware call-site rewriting
// ---------------------------------------------------------------------------

/** Resolves the canonical name for an accessed property on a library-bound local var.
 *  Returns null if the var is not a known library or the prop has no canonical mapping. */
function resolveLibraryProp(
    varName: string,
    prop: string,
    varToLib: Map<string, LibraryModuleInfo>
): { canonical: string; libType: LibraryType } | null {
    const info = varToLib.get(varName);
    if (!info || info.type === "unknown") return null;

    // Helper: is this name actually a canonical export for this library type?
    const isCanonical = (name: string): boolean => {
        if (info.type === "react") return REACT_CANONICAL.has(name);
        // Fragment is also exported by react/jsx-runtime but excluded from JSX_RUNTIME_CANONICAL
        // (which is used only for module classification). Accept it explicitly here for rewriting.
        if (info.type === "react-jsx-runtime") return JSX_RUNTIME_CANONICAL.has(name) || name === "Fragment";
        if (info.type === "react-dom-client") return REACT_DOM_CLIENT_CANONICAL.has(name);
        if (info.type === "react-router-dom") return REACT_ROUTER_DOM_CANONICAL.has(name);
        return false;
    };

    // Check exportMap: only trust the value if it IS a canonical name.
    // (Avoids mapping e.g. n.jsx = i → canonical 'i' when i is just a local fn.)
    const viaMap = info.exportMap.get(prop);
    if (viaMap && isCanonical(viaMap)) return { canonical: viaMap, libType: info.type };

    // Fall back to checking the prop name itself (handles cases where the exported
    // property name is already the canonical name, e.g. n.jsx = <iife>).
    if (isCanonical(prop)) return { canonical: prop, libType: info.type };

    return null;
}

/** Extracts `varName` and `prop` from a `(0, varName.prop)` or `varName.prop` callee. */
function tryExtractMemberCallee(callee: t.Expression): { varName: string; prop: string } | null {
    // (0, X.Y) form
    if (t.isSequenceExpression(callee) && callee.expressions.length === 2) {
        const [first, second] = callee.expressions;
        if (t.isNumericLiteral(first) && first.value === 0 && t.isMemberExpression(second)) {
            const obj = second.object;
            const prop = second.property;
            if (t.isIdentifier(obj) && t.isIdentifier(prop) && !second.computed) {
                return { varName: obj.name, prop: prop.name };
            }
        }
    }
    // X.Y form
    if (t.isMemberExpression(callee) && !callee.computed) {
        const obj = callee.object;
        const prop = callee.property;
        if (t.isIdentifier(obj) && t.isIdentifier(prop)) {
            return { varName: obj.name, prop: prop.name };
        }
    }
    return null;
}

/**
 * Pass D – rewrite library calls and collect which named exports are needed.
 *
 * Traverses all statements; for every `(0, X.Y)(args)` or `X.Y(args)` where X is a
 * known library local var, replaces the callee with the canonical identifier and records
 * the needed named import.  Also rewrites bare member expressions `X.Y` that are NOT in a
 * call position (e.g. passed as a value to another function).
 *
 * Returns the set of named exports needed per library type so the caller can build
 * proper `import { ... } from "..."` declarations.
 */
function rewriteLibraryCalls(
    statements: t.Statement[],
    varToLib: Map<string, LibraryModuleInfo>
): Map<string, Set<string>> {
    // libType → set of canonical export names actually used
    const usedExports = new Map<string, Set<string>>();

    const record = (libType: LibraryType, name: string) => {
        const src = librarySource(libType);
        if (!src) return;
        if (!usedExports.has(src)) usedExports.set(src, new Set());
        usedExports.get(src)!.add(name);
    };

    const syntheticFile = t.file(t.program(statements, [], "module"));
    traverse(syntheticFile, {
        CallExpression(p) {
            const info = tryExtractMemberCallee(p.node.callee as t.Expression);
            if (!info) return;
            const resolved = resolveLibraryProp(info.varName, info.prop, varToLib);
            if (!resolved) return;
            record(resolved.libType, resolved.canonical);
            // Replace (0, X.Y)(...) or X.Y(...) with canonicalName(...)
            p.node.callee = t.identifier(resolved.canonical);
            // Do NOT skip — arguments may contain further (0, X.Y)(...) or X.Y member refs.
        },
        MemberExpression(p) {
            // Rewrite X.Y in non-call positions (e.g. passed as callback value)
            if (p.parent && t.isCallExpression(p.parent) && p.parent.callee === p.node) return; // handled above
            const obj = p.node.object;
            const prop = p.node.property;
            if (!t.isIdentifier(obj) || !t.isIdentifier(prop) || p.node.computed) return;
            const resolved = resolveLibraryProp(obj.name, prop.name, varToLib);
            if (!resolved) return;
            record(resolved.libType, resolved.canonical);
            p.replaceWith(t.identifier(resolved.canonical));
            p.skip();
        },
        // Rewrite JSX member expressions: <ns.Component> → <CanonicalName>
        // These are JSXMemberExpression nodes (not MemberExpression), so the visitor above misses them.
        JSXOpeningElement(p) {
            const elem = p.node;
            if (!t.isJSXMemberExpression(elem.name)) return;
            const obj = elem.name.object;
            const prop = elem.name.property;
            if (!t.isJSXIdentifier(obj) || !t.isJSXIdentifier(prop)) return;
            const resolved = resolveLibraryProp(obj.name, prop.name, varToLib);
            if (!resolved) return;
            record(resolved.libType, resolved.canonical);
            elem.name = t.jsxIdentifier(resolved.canonical);
        },
        JSXClosingElement(p) {
            const elem = p.node;
            if (!t.isJSXMemberExpression(elem.name)) return;
            const obj = elem.name.object;
            const prop = elem.name.property;
            if (!t.isJSXIdentifier(obj) || !t.isJSXIdentifier(prop)) return;
            const resolved = resolveLibraryProp(obj.name, prop.name, varToLib);
            if (!resolved) return;
            // Don't record() again — already recorded from JSXOpeningElement.
            elem.name = t.jsxIdentifier(resolved.canonical);
        },
    });

    return usedExports;
}

// ---------------------------------------------------------------------------
// Pass E — Babel slicedToArray collapse
// ---------------------------------------------------------------------------

/** Returns true if the last arm of a `||` chain is an IIFE that throws TypeError. */
function isSlicedToArrayTail(node: t.Node): boolean {
    if (!t.isCallExpression(node) || node.arguments.length !== 0) return false;
    const callee = node.callee;
    if (!t.isFunctionExpression(callee) && !t.isArrowFunctionExpression(callee)) return false;
    const body = callee.body;
    if (!t.isBlockStatement(body)) return false;
    return body.body.some(
        (s) =>
            t.isThrowStatement(s) &&
            t.isNewExpression(s.argument) &&
            t.isIdentifier((s.argument as t.NewExpression).callee, { name: "TypeError" })
    );
}

function hasSlicedToArrayTail(node: t.Node): boolean {
    if (isSlicedToArrayTail(node)) return true;
    if (t.isLogicalExpression(node) && node.operator === "||") return hasSlicedToArrayTail(node.right);
    return false;
}

/**
 * Tries to detect a `var <temps>, resultVar = (<seqExpr>), target0 = resultVar[0], ...`
 * pattern produced by Babel's slicedToArray expansion.
 *
 * Returns `{ actualExpr, resultVar, targets }` on match, or null.
 */
function tryDetectSlicedToArray(decl: t.VariableDeclaration): {
    actualExpr: t.Expression;
    resultVar: string;
    targets: Array<{ id: t.Identifier; index: number }>;
} | null {
    let resultVar: string | null = null;
    let actualExpr: t.Expression | null = null;

    for (const d of decl.declarations) {
        if (!d.init || !t.isSequenceExpression(d.init)) continue;
        const exprs = d.init.expressions;
        if (exprs.length < 3) continue;
        // exprs[0]: tempVar = <actualCall>
        if (!t.isAssignmentExpression(exprs[0]) || (exprs[0] as t.AssignmentExpression).operator !== "=") continue;
        const firstAssign = exprs[0] as t.AssignmentExpression;
        if (!t.isIdentifier(firstAssign.left)) continue;
        // exprs[1]: countVar = <number>
        if (!t.isAssignmentExpression(exprs[1]) || !t.isNumericLiteral((exprs[1] as t.AssignmentExpression).right))
            continue;
        // last expr: the TypeError IIFE (possibly nested in || chain)
        if (!hasSlicedToArrayTail(exprs[exprs.length - 1])) continue;

        resultVar = t.isIdentifier(d.id) ? d.id.name : null;
        if (!resultVar) continue;
        actualExpr = firstAssign.right as t.Expression;
        break;
    }

    if (!resultVar || !actualExpr) return null;

    const targets: Array<{ id: t.Identifier; index: number }> = [];
    for (const d of decl.declarations) {
        if (!d.init || !t.isMemberExpression(d.init)) continue;
        if (!t.isIdentifier(d.init.object, { name: resultVar })) continue;
        if (!d.init.computed || !t.isNumericLiteral(d.init.property)) continue;
        if (!t.isIdentifier(d.id)) continue;
        targets.push({ id: d.id as t.Identifier, index: (d.init.property as t.NumericLiteral).value });
    }

    return targets.length > 0 ? { actualExpr, resultVar, targets } : null;
}

/** Collapse Babel slicedToArray expansions in a statement list (including nested blocks). */
function collapseSlicedToArray(statements: t.Statement[]): t.Statement[] {
    const out: t.Statement[] = [];
    for (const stmt of statements) {
        // Recurse into block statements (e.g. if/else, function bodies handled via traversal)
        if (t.isBlockStatement(stmt)) {
            stmt.body = collapseSlicedToArray(stmt.body);
            out.push(stmt);
            continue;
        }

        if (!t.isVariableDeclaration(stmt)) {
            out.push(stmt);
            continue;
        }

        const match = tryDetectSlicedToArray(stmt);
        if (!match) {
            out.push(stmt);
            continue;
        }

        const { actualExpr, resultVar, targets } = match;
        // Sort targets by index so array pattern elements are in order
        const sorted = [...targets].sort((a, b) => a.index - b.index);
        const pattern = t.arrayPattern(sorted.map((tgt) => tgt.id as unknown as t.PatternLike));
        out.push(t.variableDeclaration("const", [t.variableDeclarator(pattern, actualExpr)]));
    }
    return out;
}

// ---------------------------------------------------------------------------
// Pass E.2 — collapse named slicedToArray helper calls
// ---------------------------------------------------------------------------

/**
 * Detects a named slicedToArray helper function by the TypeError throw at the
 * end of its body.  Shape: function(e, t) { return ... || (() => { throw new TypeError("...non-iterable...") })() }
 */
function isNamedSlicedToArrayHelper(stmt: t.Statement): string | null {
    if (!t.isFunctionDeclaration(stmt) || !stmt.id || stmt.params.length !== 2) return null;
    // Direct name match: _slicedToArray is always a Babel array-destructure helper.
    if (stmt.id.name === "_slicedToArray" || stmt.id.name === "slicedToArray") return stmt.id.name;
    const body = stmt.body.body;
    if (body.length === 0) return null;
    const last = body[body.length - 1];
    if (!t.isReturnStatement(last) || !last.argument) return null;
    // The return value must (somewhere in its || chain) throw new TypeError
    const hasTypeError = (node: t.Node): boolean => {
        if (
            t.isCallExpression(node) &&
            (t.isFunctionExpression(node.callee) || t.isArrowFunctionExpression(node.callee))
        ) {
            const innerBody = (node.callee as t.FunctionExpression).body;
            if (t.isBlockStatement(innerBody)) {
                return innerBody.body.some(
                    (s) =>
                        t.isThrowStatement(s) &&
                        t.isNewExpression(s.argument) &&
                        t.isIdentifier((s.argument as t.NewExpression).callee, { name: "TypeError" }) &&
                        (s.argument as t.NewExpression).arguments.some(
                            (a) => t.isStringLiteral(a) && (a as t.StringLiteral).value.includes("non-iterable")
                        )
                );
            }
        }
        if (t.isLogicalExpression(node) && node.operator === "||") return hasTypeError(node.right);
        return false;
    };
    return hasTypeError(last.argument) ? stmt.id.name : null;
}

/**
 * Collapses `const temp = helper(expr, n), a = temp[0], b = temp[1]` into
 * `const [a, b] = expr` for a given list of statements, knowing which function
 * names are slicedToArray helpers (passed in as `helperNames`).
 */
function collapseSlicedToArrayCalls(stmts: t.Statement[], helperNames: Set<string>): t.Statement[] {
    if (helperNames.size === 0) return stmts;
    const out: t.Statement[] = [];
    for (const stmt of stmts) {
        if (!t.isVariableDeclaration(stmt)) {
            out.push(stmt);
            continue;
        }
        const decls = stmt.declarations;
        const newDecls: t.VariableDeclarator[] = [];
        let i = 0;
        while (i < decls.length) {
            const d = decls[i];
            if (!t.isIdentifier(d.id) || !d.init || !t.isCallExpression(d.init)) {
                newDecls.push(d);
                i++;
                continue;
            }
            const callExpr = d.init as t.CallExpression;
            const callee = callExpr.callee;
            if (!t.isIdentifier(callee) || !helperNames.has((callee as t.Identifier).name)) {
                newDecls.push(d);
                i++;
                continue;
            }
            const tempName = (d.id as t.Identifier).name;
            let actualExpr = callExpr.arguments[0] as t.Expression;
            // If actualExpr references the immediately preceding declarator, inline its init
            // so we get `const [a, b] = actualCall` instead of `const _x = actualCall, [a, b] = _x`.
            if (
                t.isIdentifier(actualExpr) &&
                newDecls.length > 0 &&
                t.isIdentifier(newDecls[newDecls.length - 1].id) &&
                (newDecls[newDecls.length - 1].id as t.Identifier).name === (actualExpr as t.Identifier).name &&
                newDecls[newDecls.length - 1].init != null
            ) {
                actualExpr = newDecls[newDecls.length - 1].init as t.Expression;
                newDecls.pop(); // remove the now-inlined declarator
            }
            const targets: Array<{ id: t.Identifier; index: number }> = [];
            let j = i + 1;
            while (j < decls.length) {
                const nd = decls[j];
                if (
                    !t.isIdentifier(nd.id) ||
                    !nd.init ||
                    !t.isMemberExpression(nd.init) ||
                    !(nd.init as t.MemberExpression).computed ||
                    !t.isIdentifier((nd.init as t.MemberExpression).object, { name: tempName }) ||
                    !t.isNumericLiteral((nd.init as t.MemberExpression).property)
                )
                    break;
                targets.push({
                    id: nd.id as t.Identifier,
                    index: ((nd.init as t.MemberExpression).property as t.NumericLiteral).value,
                });
                j++;
            }
            if (targets.length > 0) {
                const sorted = [...targets].sort((a, b) => a.index - b.index);
                const pattern = t.arrayPattern(sorted.map((tgt) => tgt.id as unknown as t.PatternLike));
                newDecls.push(t.variableDeclarator(pattern, actualExpr));
                i = j;
            } else {
                newDecls.push(d);
                i++;
            }
        }
        if (newDecls.length > 0) out.push(t.variableDeclaration(stmt.kind, newDecls));
    }
    return out;
}

/**
 * Given a list of statements, finds any named slicedToArray helpers, then:
 * 1. Collapses `const temp = helper(expr, n), a = temp[0], b = temp[1]` → `const [a, b] = expr`
 * 2. Rewrites inline `helper(expr, n)[k]` → `expr[k]` (single-element extraction with chained access)
 * 3. Removes the helper declarations once they are no longer referenced.
 */
function collapseNamedSlicedToArray(statements: t.Statement[]): t.Statement[] {
    const helperNames = new Set<string>();
    for (const stmt of statements) {
        const name = isNamedSlicedToArrayHelper(stmt);
        if (name) helperNames.add(name);
    }
    if (helperNames.size === 0) return statements;

    // Remove helper declarations and collapse top-level declarator-sequence usages
    const withoutHelpers = statements.filter(
        (s) => !(t.isFunctionDeclaration(s) && s.id && helperNames.has(s.id.name))
    );
    const topCollapsed = collapseSlicedToArrayCalls(withoutHelpers, helperNames);

    // Recurse into nested function bodies via traverse — collapse declarator sequences
    const syntheticFile = t.file(t.program(topCollapsed, [], "module"));
    traverse(syntheticFile, {
        BlockStatement(p) {
            const collapsed = collapseSlicedToArrayCalls(p.node.body, helperNames);
            if (collapsed !== p.node.body) p.node.body = collapsed;
        },
        // Rewrite inline `helper(expr, n)[k]` → `expr[k]`
        MemberExpression(p) {
            const node = p.node as t.MemberExpression;
            if (!node.computed) return;
            if (!t.isNumericLiteral(node.property)) return;
            if (!t.isCallExpression(node.object)) return;
            const call = node.object as t.CallExpression;
            if (!t.isIdentifier(call.callee) || !helperNames.has((call.callee as t.Identifier).name)) return;
            const actualExpr = call.arguments[0] as t.Expression;
            if (!actualExpr) return;
            p.replaceWith(t.memberExpression(actualExpr, node.property, true));
            p.skip();
        },
    });
    return topCollapsed;
}

/** Traverse all function bodies in a statement list and collapse slicedToArray inside them. */
function collapseSlicedToArrayDeep(statements: t.Statement[]): t.Statement[] {
    // First collapse named helpers (module-level factored-out slicedToArray function).
    // This also recurses into all nested function bodies via traverse internally.
    const afterNamed = collapseNamedSlicedToArray(statements);
    // Collapse the inline expansion pattern at top level
    const top = collapseSlicedToArray(afterNamed);
    // Then recurse into function bodies via a traverse for the inline pattern
    const syntheticFile = t.file(t.program(top, [], "module"));
    traverse(syntheticFile, {
        BlockStatement(p) {
            const collapsed = collapseSlicedToArray(p.node.body);
            if (collapsed !== p.node.body) {
                p.node.body = collapsed;
            }
        },
    });
    return top;
}

// ---------------------------------------------------------------------------
// Pass F — JSX recovery
// ---------------------------------------------------------------------------

function exprToJsxName(expr: t.Expression): t.JSXIdentifier | t.JSXMemberExpression | null {
    if (t.isStringLiteral(expr)) return t.jsxIdentifier(expr.value);
    // Handle template literals with no expressions: `div` → "div"
    if (t.isTemplateLiteral(expr) && expr.expressions.length === 0 && expr.quasis.length === 1) {
        const raw = expr.quasis[0].value.cooked ?? expr.quasis[0].value.raw;
        if (raw) return t.jsxIdentifier(raw);
    }
    if (t.isIdentifier(expr)) return t.jsxIdentifier(expr.name);
    if (t.isMemberExpression(expr) && !expr.computed && t.isIdentifier(expr.property)) {
        const obj = exprToJsxName(expr.object as t.Expression);
        if (obj)
            return t.jsxMemberExpression(
                obj as t.JSXIdentifier | t.JSXMemberExpression,
                t.jsxIdentifier((expr.property as t.Identifier).name)
            );
    }
    return null;
}

function exprToJsxAttrValue(expr: t.Expression): t.JSXExpressionContainer | t.StringLiteral {
    if (t.isStringLiteral(expr)) return expr;
    return t.jsxExpressionContainer(expr);
}

function childToJsxChild(
    child: t.Expression
): t.JSXElement | t.JSXFragment | t.JSXText | t.JSXExpressionContainer | t.JSXSpreadChild | null {
    if (t.isStringLiteral(child)) return t.jsxText(child.value);
    // Template literal with no expressions: `Dashboard` → JSXText
    if (t.isTemplateLiteral(child) && child.expressions.length === 0 && child.quasis.length === 1) {
        const raw = child.quasis[0].value.cooked ?? child.quasis[0].value.raw;
        if (raw !== undefined) return t.jsxText(raw);
    }
    if (t.isJSXElement(child) || t.isJSXFragment(child)) return child;
    // Recursively convert nested jsx(...) calls into JSX elements.
    if (t.isCallExpression(child)) {
        const converted = tryConvertToJSX(child);
        if (converted) return converted;
    }
    return t.jsxExpressionContainer(child);
}

// Detect Babel's compiled object-spread IIFE:
//   (function(target) { for(var i=1; i<arguments.length; i++){...} return target; })(base, spread1, ...)
// Returns { base, spreads } if matched, null otherwise.
function tryUnpackSpreadIIFE(expr: t.Expression): { base: t.Expression; spreads: t.Expression[] } | null {
    if (!t.isCallExpression(expr)) return null;
    const callee = expr.callee;
    if (!t.isFunctionExpression(callee)) return null;
    if (callee.params.length !== 1 || !t.isIdentifier(callee.params[0])) return null;
    const paramName = (callee.params[0] as t.Identifier).name;
    const body = callee.body.body;
    if (body.length < 2) return null;
    // Must contain a for loop that iterates `arguments.length`
    const hasArgumentsLoop = body.some((s) => {
        if (!t.isForStatement(s) || !s.test || !t.isBinaryExpression(s.test)) return false;
        const right = (s.test as t.BinaryExpression).right;
        return (
            (s.test as t.BinaryExpression).operator === "<" &&
            t.isMemberExpression(right) &&
            t.isIdentifier((right as t.MemberExpression).object, { name: "arguments" }) &&
            t.isIdentifier((right as t.MemberExpression).property, { name: "length" })
        );
    });
    if (!hasArgumentsLoop) return null;
    // Must return the first param
    const hasReturn = body.some(
        (s) => t.isReturnStatement(s) && s.argument && t.isIdentifier(s.argument, { name: paramName })
    );
    if (!hasReturn) return null;
    const args = expr.arguments as t.Expression[];
    if (args.length < 1) return null;
    return { base: args[0], spreads: args.slice(1) };
}

/** Build JSXAttributes + children from an ObjectExpression or a spread-IIFE propsArg. */
function propsArgToAttrsAndChildren(propsArg: t.Expression): {
    attrs: Array<t.JSXAttribute | t.JSXSpreadAttribute>;
    childExprs: t.Expression[];
} {
    const attrs: Array<t.JSXAttribute | t.JSXSpreadAttribute> = [];
    const childExprs: t.Expression[] = [];

    const processObjectExpr = (obj: t.ObjectExpression) => {
        for (const prop of obj.properties) {
            if (t.isSpreadElement(prop)) {
                attrs.push(t.jsxSpreadAttribute(prop.argument as t.Expression));
                continue;
            }
            if (!t.isObjectProperty(prop) || prop.computed) continue;
            const keyNode = prop.key;
            const valNode = prop.value as t.Expression;
            const keyName = t.isIdentifier(keyNode) ? keyNode.name : t.isStringLiteral(keyNode) ? keyNode.value : null;
            if (!keyName) continue;
            if (keyName === "children") {
                if (t.isArrayExpression(valNode)) {
                    for (const el of valNode.elements) {
                        if (el) childExprs.push(el as t.Expression);
                    }
                } else {
                    childExprs.push(valNode);
                }
                continue;
            }
            attrs.push(t.jsxAttribute(t.jsxIdentifier(keyName), exprToJsxAttrValue(valNode)));
        }
    };

    if (t.isObjectExpression(propsArg)) {
        processObjectExpr(propsArg);
    } else {
        // Try to unpack Babel's compiled object-spread IIFE
        const unpacked = tryUnpackSpreadIIFE(propsArg);
        if (unpacked) {
            if (t.isObjectExpression(unpacked.base)) {
                processObjectExpr(unpacked.base);
            } else {
                attrs.push(t.jsxSpreadAttribute(unpacked.base));
            }
            for (const spreadExpr of unpacked.spreads) {
                attrs.push(t.jsxSpreadAttribute(spreadExpr));
            }
        } else {
            // Fallback: emit the entire props argument as a single JSX spread
            attrs.push(t.jsxSpreadAttribute(propsArg));
        }
    }

    return { attrs, childExprs };
}

const JSX_METHOD_NAMES = new Set(["jsx", "jsxs", "jsxDEV"]);

// Extract the jsx method name from a callee that may be:
//   - bare identifier: `jsx`
//   - member expression: `ns.jsx`
//   - sequence (0, ns.jsx) after a `(0, ...)()` call
// Returns the method name string, or null if not a jsx call.
function getJsxMethodName(callee: t.Expression): string | null {
    if (t.isIdentifier(callee) && JSX_METHOD_NAMES.has((callee as t.Identifier).name)) {
        return (callee as t.Identifier).name;
    }
    if (t.isMemberExpression(callee) && !callee.computed) {
        const prop = (callee as t.MemberExpression).property;
        if (t.isIdentifier(prop) && JSX_METHOD_NAMES.has((prop as t.Identifier).name)) {
            return (prop as t.Identifier).name;
        }
    }
    // (0, ns.jsx) sequence expression
    if (t.isSequenceExpression(callee)) {
        const exprs = (callee as t.SequenceExpression).expressions;
        const last = exprs[exprs.length - 1];
        if (last && t.isMemberExpression(last) && !last.computed) {
            const prop = (last as t.MemberExpression).property;
            if (t.isIdentifier(prop) && JSX_METHOD_NAMES.has((prop as t.Identifier).name)) {
                return (prop as t.Identifier).name;
            }
        }
    }
    return null;
}

function tryConvertToJSX(call: t.CallExpression): t.JSXElement | t.JSXFragment | null {
    const callee = call.callee;
    const methodName = getJsxMethodName(callee as t.Expression);
    if (!methodName) return null;
    if (call.arguments.length < 2) return null;

    const tagArg = call.arguments[0] as t.Expression;
    const propsArg = call.arguments[1] as t.Expression;

    const jsxName = exprToJsxName(tagArg);
    if (!jsxName) return null;

    type JSXChild = t.JSXElement | t.JSXFragment | t.JSXText | t.JSXExpressionContainer | t.JSXSpreadChild;

    const { attrs, childExprs } = propsArgToAttrsAndChildren(propsArg);
    const children: JSXChild[] = childExprs.map((e) => childToJsxChild(e)).filter(Boolean) as JSXChild[];

    // Fragment identifier → JSXFragment shorthand (<>...</>)
    if (t.isJSXIdentifier(jsxName) && jsxName.name === "Fragment") {
        return t.jsxFragment(t.jsxOpeningFragment(), t.jsxClosingFragment(), children);
    }

    const jsxAttrs = attrs.filter(
        (a): a is t.JSXAttribute | t.JSXSpreadAttribute => t.isJSXAttribute(a) || t.isJSXSpreadAttribute(a)
    );
    const selfClosing = children.length === 0;
    const openingElement = t.jsxOpeningElement(jsxName, jsxAttrs, selfClosing);
    const closingElement = selfClosing ? null : t.jsxClosingElement(jsxName);

    return t.jsxElement(openingElement, closingElement, children);
}

/** Traverse statements and replace jsx()/jsxs() calls with JSXElement nodes. */
function recoverJSX(statements: t.Statement[]): void {
    const syntheticFile = t.file(t.program(statements, [], "module"));
    traverse(syntheticFile, {
        CallExpression(p) {
            const jsxEl = tryConvertToJSX(p.node);
            if (!jsxEl) return;
            p.replaceWith(jsxEl);
            // Do NOT skip — nested jsx calls inside lambdas/expression containers need visiting.
        },
    });
}

// ---------------------------------------------------------------------------
// Pass G — remove top-level Babel helpers and webpack internals
// ---------------------------------------------------------------------------

function isBabelArrayLikeToArrayHelper(stmt: t.Statement): boolean {
    if (!t.isFunctionDeclaration(stmt) || !stmt.id) return false;
    const body = stmt.body.body;
    if (body.length < 2 || body.length > 4) return false;
    // Key signal: contains `for (var ... = Array(n); ...)` and a return of the array
    const hasArrayOf = body.some((s) => {
        if (!t.isForStatement(s)) return false;
        const init = s.init;
        if (!t.isVariableDeclaration(init)) return false;
        return init.declarations.some(
            (d) =>
                d.init &&
                t.isCallExpression(d.init) &&
                t.isIdentifier((d.init as t.CallExpression).callee, { name: "Array" })
        );
    });
    return hasArrayOf;
}

// Detect `_typeof` — Babel's lazy-init typeof polyfill.
// Shape: 1-param function whose sole body statement is
//   return ((fnName = <conditional>), fnName(arg))
function isBabelTypeofHelper(stmt: t.Statement): boolean {
    if (!t.isFunctionDeclaration(stmt) || !stmt.id || stmt.params.length !== 1) return false;
    const body = stmt.body.body;
    if (body.length !== 1 || !t.isReturnStatement(body[0])) return false;
    const arg = (body[0] as t.ReturnStatement).argument;
    if (!arg || !t.isSequenceExpression(arg)) return false;
    const exprs = (arg as t.SequenceExpression).expressions;
    if (exprs.length !== 2) return false;
    const first = exprs[0];
    return (
        t.isAssignmentExpression(first) &&
        t.isIdentifier((first as t.AssignmentExpression).left, { name: stmt.id.name })
    );
}

// Detect `_defineProperty` / `_toPropertyKey`+`_defineProperty` combos.
// Shape: 3-param function whose body contains an Object.defineProperty call with
//   { value, enumerable, configurable, writable } descriptor.
function isBabelDefinePropertyHelper(stmt: t.Statement): boolean {
    if (!t.isFunctionDeclaration(stmt) || !stmt.id || stmt.params.length !== 3) return false;
    const bodyCode = stmt.body.body;
    const hasDefProp = (node: t.Node): boolean => {
        if (
            t.isCallExpression(node) &&
            t.isMemberExpression((node as t.CallExpression).callee) &&
            t.isIdentifier(((node as t.CallExpression).callee as t.MemberExpression).object, { name: "Object" }) &&
            t.isIdentifier(((node as t.CallExpression).callee as t.MemberExpression).property, {
                name: "defineProperty",
            })
        ) {
            const args = (node as t.CallExpression).arguments;
            if (args.length >= 3 && t.isObjectExpression(args[2])) {
                const props = (args[2] as t.ObjectExpression).properties;
                const keys = props
                    .filter((p) => t.isObjectProperty(p) && t.isIdentifier((p as t.ObjectProperty).key))
                    .map((p) => ((p as t.ObjectProperty).key as t.Identifier).name);
                return keys.includes("enumerable") && keys.includes("configurable") && keys.includes("writable");
            }
        }
        return false;
    };
    // Walk statements for the defineProperty call (may be nested in return/conditional)
    const walk = (node: t.Node): boolean => {
        if (hasDefProp(node)) return true;
        for (const key of Object.keys(node)) {
            const child = (node as unknown as Record<string, unknown>)[key];
            if (!child || typeof child !== "object") continue;
            if (Array.isArray(child)) {
                if (
                    child.some(
                        (c: unknown) => c && typeof c === "object" && "type" in (c as object) && walk(c as t.Node)
                    )
                )
                    return true;
            } else if ("type" in (child as object)) {
                if (walk(child as t.Node)) return true;
            }
        }
        return false;
    };
    return bodyCode.some((s) => walk(s));
}

// Detect `_objectSpreadPropsHelper` / `_objectKeys`.
// Shape: 2-param function whose first statement declares a variable via Object.keys(param0)
//   and whose body references getOwnPropertySymbols.
function isBabelObjectSpreadHelper(stmt: t.Statement): boolean {
    if (!t.isFunctionDeclaration(stmt) || !stmt.id || stmt.params.length !== 2) return false;
    const body = stmt.body.body;
    if (body.length < 2) return false;
    // First statement: var t = Object.keys(e)
    const first = body[0];
    if (!t.isVariableDeclaration(first)) return false;
    const firstIsObjectKeys = (first as t.VariableDeclaration).declarations.some((d) => {
        if (!d.init || !t.isCallExpression(d.init)) return false;
        const callee = (d.init as t.CallExpression).callee;
        return (
            t.isMemberExpression(callee) &&
            t.isIdentifier((callee as t.MemberExpression).object, { name: "Object" }) &&
            t.isIdentifier((callee as t.MemberExpression).property, { name: "keys" })
        );
    });
    if (!firstIsObjectKeys) return false;
    // Body references getOwnPropertySymbols
    const bodyStr = JSON.stringify(body);
    return bodyStr.includes('"getOwnPropertySymbols"');
}

// Detect `_objectSpread2` — Babel's 1-param spread helper that uses arguments.length
// and Object.defineProperties to merge source objects into the target.
function isBabelObjectSpread2Helper(stmt: t.Statement): boolean {
    if (!t.isFunctionDeclaration(stmt)) return false;
    const params = stmt.params;
    if (params.length !== 1) return false;
    const body = stmt.body.body;
    // Must have a for loop that reads arguments.length, then calls Object.defineProperties
    const hasArgumentsLength = JSON.stringify(body).includes('"arguments"');
    const hasDefineProperties =
        JSON.stringify(body).includes('"defineProperties"') || JSON.stringify(body).includes('"defineProperty"');
    return hasArgumentsLength && hasDefineProperties;
}

// Detect `_ownKeys` / `ownKeys` — companion helper to _objectSpread2.
// Shape: 1- or 2-param function whose first statement declares a var via Object.keys(param)
//   and whose body references getOwnPropertySymbols.
function isBabelOwnKeysHelper(stmt: t.Statement): boolean {
    if (!t.isFunctionDeclaration(stmt)) return false;
    const params = stmt.params;
    if (params.length < 1 || params.length > 2) return false;
    const body = stmt.body.body;
    if (body.length === 0) return false;
    // First statement declares a var via Object.keys(param)
    const first = body[0];
    if (!t.isVariableDeclaration(first)) return false;
    const bodyStr = JSON.stringify(body);
    return bodyStr.includes('"keys"') && bodyStr.includes('"getOwnPropertySymbols"');
}

// Named Babel array-destructure companion helpers that appear as FunctionDeclarations.
const NAMED_BABEL_ARRAY_HELPERS = new Set([
    "_arrayWithHoles",
    "_arrayLikeToArray",
    "_iterableToArrayLimit",
    "_unsupportedIterableToArray",
    "_nonIterableRest",
]);

function isNamedBabelArrayHelper(stmt: t.Statement): boolean {
    return t.isFunctionDeclaration(stmt) && stmt.id != null && NAMED_BABEL_ARRAY_HELPERS.has(stmt.id.name);
}

/** Remove `var x = {}` declarations where every declarator has an empty-object init.
 *  These are webpack module-cache variables. */
function dropEmptyObjectVars(stmts: t.Statement[]): t.Statement[] {
    return stmts.filter((stmt) => {
        if (!t.isVariableDeclaration(stmt)) return true;
        return !stmt.declarations.every(
            (d) => d.init && t.isObjectExpression(d.init) && (d.init as t.ObjectExpression).properties.length === 0
        );
    });
}

// ---------------------------------------------------------------------------
// Pass H — prune unused named imports (e.g. jsx/jsxs after JSX recovery)
// ---------------------------------------------------------------------------

/** Collect all free identifier references in the given statements. */
function collectReferencedNames(stmts: t.Statement[]): Set<string> {
    const names = new Set<string>();
    const syntheticFile = t.file(t.program(stmts, [], "module"));
    traverse(syntheticFile, {
        Identifier(p) {
            // Skip identifier nodes that are property names or binding declarations
            if (p.parentPath?.isImportSpecifier()) return;
            if (p.parentPath?.isImportDefaultSpecifier()) return;
            if (p.parentPath?.isImportNamespaceSpecifier()) return;
            if (
                p.parentPath?.isMemberExpression() &&
                !(p.parent as t.MemberExpression).computed &&
                p.parentPath.get("property") === p
            )
                return;
            if (
                p.parentPath?.isObjectProperty() &&
                !(p.parent as t.ObjectProperty).computed &&
                p.parentPath.get("key") === p
            )
                return;
            if (p.parentPath?.isJSXAttribute()) return;
            if (p.parentPath?.isJSXOpeningElement() || p.parentPath?.isJSXClosingElement()) return;
            names.add(p.node.name);
        },
        JSXIdentifier(p) {
            // JSX element names (e.g. <Fragment>) are JSXIdentifier nodes, not Identifier.
            // Add them so their import specifiers survive Pass H pruning.
            names.add(p.node.name);
        },
    });
    return names;
}

/** Remove named import specifiers whose local name is not referenced in `bodyStmts`. */
function pruneUnusedNamedImports(importStmts: t.Statement[], bodyStmts: t.Statement[]): t.Statement[] {
    const refs = collectReferencedNames(bodyStmts);
    return importStmts
        .map((stmt) => {
            if (!t.isImportDeclaration(stmt)) return stmt;
            const prunedSpecifiers = stmt.specifiers.filter((spec) => {
                if (t.isImportNamespaceSpecifier(spec)) return true; // always keep namespace imports
                if (t.isImportDefaultSpecifier(spec)) return true;
                if (t.isImportSpecifier(spec)) {
                    const localName = t.isIdentifier(spec.local) ? spec.local.name : null;
                    return localName ? refs.has(localName) : true;
                }
                return true;
            });
            if (prunedSpecifiers.length === 0) return null; // drop empty imports
            if (prunedSpecifiers.length === stmt.specifiers.length) return stmt; // unchanged
            return t.importDeclaration(prunedSpecifiers, stmt.source);
        })
        .filter(Boolean) as t.Statement[];
}

// ---------------------------------------------------------------------------
// Pass D for module files — library-aware import rewriting
// ---------------------------------------------------------------------------

/**
 * Applies Pass D to an already-transformed module file whose imports are in the
 * form `import * as ns from './N.js'`.  Looks up each module ID `N` in
 * `libModuleMap`, rewrites call-sites from `(0, ns.hook)(...)` to `hook(...)`,
 * replaces namespace imports with named imports from the real library path, and
 * prunes unused specifiers.
 *
 * Returns the rewritten statement list (imports first, then body).
 * If `libModuleMap` is empty / not provided, returns `statements` unchanged.
 */
export const applyLibraryImportRewriting = (
    statements: t.Statement[],
    libModuleMap: Map<string, LibraryModuleInfo>
): t.Statement[] => {
    if (!libModuleMap || libModuleMap.size === 0) return statements;

    // Separate existing import declarations from body statements
    const importDecls: t.ImportDeclaration[] = [];
    const bodyStmts: t.Statement[] = [];
    for (const stmt of statements) {
        if (t.isImportDeclaration(stmt)) importDecls.push(stmt as t.ImportDeclaration);
        else bodyStmts.push(stmt);
    }

    // Build varName → moduleId from `import * as ns from './N.js'`
    const varToModuleId = new Map<string, number>(); // ns → numericModuleId
    for (const decl of importDecls) {
        const source = (decl as t.ImportDeclaration).source.value;
        const match = source.match(/^\.\/(\d+)\.js$/);
        if (!match) continue;
        const numId = parseInt(match[1], 10);
        for (const spec of (decl as t.ImportDeclaration).specifiers) {
            if (t.isImportNamespaceSpecifier(spec)) {
                varToModuleId.set((spec.local as t.Identifier).name, numId);
            }
        }
    }

    // Build varName → LibraryModuleInfo
    const varToLib = new Map<string, LibraryModuleInfo>();
    for (const [varName, numId] of varToModuleId) {
        const info = libModuleMap.get(String(numId));
        if (info) varToLib.set(varName, info);
    }
    if (varToLib.size === 0) return statements;

    // --- CSS injection stripping ---
    // Collect CSS-typed import vars (style-loader, css-module)
    const cssImportVars = new Set<string>();
    for (const [varName, info] of varToLib) {
        if (info.type === "style-loader" || info.type === "css-module") {
            cssImportVars.add(varName);
        }
    }
    if (cssImportVars.size > 0) {
        const CSS_INJECT_PROPS = new Set([
            "styleTagTransform",
            "setAttributes",
            "insert",
            "domAPI",
            "insertStyleElement",
        ]);

        // Find CSS wrapper vars: var x = <expr>.n(libVar) for any library import.
        // webpack's .n() (interopRequireDefault) only appears in the CSS injection
        // setup in React apps; it's safe to strip all library-import .n() wrappers.
        const allLibVars = new Set<string>(varToLib.keys());
        const cssWrapperVars = new Set<string>();
        for (const stmt of bodyStmts) {
            if (!t.isVariableDeclaration(stmt)) continue;
            for (const decl of stmt.declarations) {
                if (!t.isIdentifier(decl.id) || !decl.init) continue;
                if (!t.isCallExpression(decl.init)) continue;
                const callee = (decl.init as t.CallExpression).callee;
                const args = (decl.init as t.CallExpression).arguments;
                if (
                    t.isMemberExpression(callee) &&
                    !(callee as t.MemberExpression).computed &&
                    t.isIdentifier((callee as t.MemberExpression).property, { name: "n" }) &&
                    args.length === 1 &&
                    t.isIdentifier(args[0]) &&
                    allLibVars.has((args[0] as t.Identifier).name)
                ) {
                    cssWrapperVars.add((decl.id as t.Identifier).name);
                }
            }
        }

        // Find CSS config object vars: var g = {} where g is assigned CSS injection props
        const cssConfigObjVars = new Set<string>();
        for (const stmt of bodyStmts) {
            if (!t.isExpressionStatement(stmt)) continue;
            const expr = stmt.expression;
            if (!t.isAssignmentExpression(expr)) continue;
            const lhs = expr.left;
            if (!t.isMemberExpression(lhs) || (lhs as t.MemberExpression).computed) continue;
            const prop = (lhs as t.MemberExpression).property;
            if (t.isIdentifier(prop) && CSS_INJECT_PROPS.has((prop as t.Identifier).name)) {
                if (t.isIdentifier((lhs as t.MemberExpression).object))
                    cssConfigObjVars.add(((lhs as t.MemberExpression).object as t.Identifier).name);
            }
        }

        const isCssMemberRef = (e: t.Expression): boolean => {
            if (!t.isMemberExpression(e) || (e as t.MemberExpression).computed) return false;
            return (
                t.isIdentifier((e as t.MemberExpression).object) &&
                cssImportVars.has(((e as t.MemberExpression).object as t.Identifier).name)
            );
        };

        const hasLogicalCssRef = (e: t.Expression): boolean => {
            if (isCssMemberRef(e)) return true;
            if (t.isLogicalExpression(e))
                return (
                    hasLogicalCssRef((e as t.LogicalExpression).left) ||
                    hasLogicalCssRef((e as t.LogicalExpression).right)
                );
            return false;
        };

        const isCssInjectionStmt = (stmt: t.Statement): boolean => {
            if (!t.isExpressionStatement(stmt)) return false;
            const expr = stmt.expression;
            // g.styleTagTransform = ..., g.setAttributes = ..., etc.
            if (
                t.isAssignmentExpression(expr) &&
                t.isMemberExpression(expr.left) &&
                !(expr.left as t.MemberExpression).computed &&
                t.isIdentifier((expr.left as t.MemberExpression).property) &&
                CSS_INJECT_PROPS.has(((expr.left as t.MemberExpression).property as t.Identifier).name)
            )
                return true;
            // cssWrapperVar()(cssModuleVar.A, configObj)
            if (t.isCallExpression(expr) && t.isCallExpression(expr.callee)) {
                const innerCallee = (expr.callee as t.CallExpression).callee;
                if (t.isIdentifier(innerCallee) && cssWrapperVars.has((innerCallee as t.Identifier).name)) return true;
            }
            // cssModuleVar.A && cssModuleVar.A.locals && cssModuleVar.A.locals
            if (t.isLogicalExpression(expr) && hasLogicalCssRef(expr as t.LogicalExpression)) return true;
            return false;
        };

        const filteredStmts: t.Statement[] = [];
        for (const stmt of bodyStmts) {
            if (isCssInjectionStmt(stmt)) continue;
            if (t.isVariableDeclaration(stmt)) {
                const remaining = stmt.declarations.filter((decl) => {
                    if (!t.isIdentifier(decl.id)) return true;
                    const name = (decl.id as t.Identifier).name;
                    if (cssWrapperVars.has(name)) return false;
                    if (
                        cssConfigObjVars.has(name) &&
                        decl.init &&
                        t.isObjectExpression(decl.init) &&
                        (decl.init as t.ObjectExpression).properties.length === 0
                    )
                        return false;
                    return true;
                });
                if (remaining.length === 0) continue;
                filteredStmts.push(
                    remaining.length < stmt.declarations.length ? t.variableDeclaration(stmt.kind, remaining) : stmt
                );
                continue;
            }
            filteredStmts.push(stmt);
        }
        bodyStmts.splice(0, bodyStmts.length, ...filteredStmts);
    }

    // Rewrite call-sites in bodyStmts; collect used exports per library
    const usedExports = rewriteLibraryCalls(bodyStmts, varToLib);

    // Build replacement import declarations
    const finalImportStmts: t.Statement[] = [];
    const handledSpecs = new Set<string>();

    for (const [varName, info] of varToLib) {
        const src = librarySource(info.type);
        if (!src) continue;
        if (!handledSpecs.has(src)) {
            handledSpecs.add(src);
            const used = usedExports.get(src);
            if (used && used.size > 0) {
                const specifiers = [...used]
                    .sort()
                    .map((name) => t.importSpecifier(t.identifier(name), t.identifier(name)));
                finalImportStmts.push(t.importDeclaration(specifiers, t.stringLiteral(src)));
            }
        }
    }

    // Keep non-library namespace imports unchanged.
    // For library namespace imports: keep only if the namespace variable is still used as
    // the object of a MemberExpression or JSXMemberExpression (i.e., namespace access).
    // Using collectReferencedNames would falsely keep imports when a local variable in a
    // closure happens to share the namespace name (e.g. `const n = e.toLowerCase()`).
    const namespaceObjRefs = new Set<string>();
    {
        const syntheticFile = t.file(t.program(bodyStmts as t.Statement[], [], "module"));
        traverse(syntheticFile, {
            MemberExpression(p) {
                if (!p.node.computed && t.isIdentifier(p.node.object)) {
                    namespaceObjRefs.add((p.node.object as t.Identifier).name);
                }
            },
            JSXMemberExpression(p) {
                if (t.isJSXIdentifier(p.node.object)) {
                    namespaceObjRefs.add((p.node.object as t.JSXIdentifier).name);
                }
            },
        });
    }

    for (const decl of importDecls) {
        const source = (decl as t.ImportDeclaration).source.value;
        const match = source.match(/^\.\/(\d+)\.js$/);
        if (!match) {
            finalImportStmts.push(decl);
            continue;
        }
        const numId = parseInt(match[1], 10);
        const isLibrary = [...varToModuleId.entries()].some(([vn, id]) => id === numId && varToLib.has(vn));
        if (!isLibrary) {
            finalImportStmts.push(decl);
            continue;
        }
        // Library module: keep the namespace import only if the namespace var is
        // still used as a namespace object (i.e. some exports were not resolved).
        const hasRemainingRefs = (decl as t.ImportDeclaration).specifiers.some(
            (spec) => t.isImportNamespaceSpecifier(spec) && namespaceObjRefs.has((spec.local as t.Identifier).name)
        );
        if (hasRemainingRefs) finalImportStmts.push(decl);
    }

    // Pass H — prune named imports that are no longer referenced
    const prunedImports = pruneUnusedNamedImports(finalImportStmts, bodyStmts);

    return [...prunedImports, ...bodyStmts];
};

// ---------------------------------------------------------------------------
// Module cleanup passes — applies E/F/G standalone (no webpack require context needed)
// ---------------------------------------------------------------------------

/**
 * Applies JSX recovery, slicedToArray collapse, and Babel helper removal to
 * any list of statements.  Used for both individual module files and index.js.
 * Does NOT require a webpack require-function name or library module map.
 */
export const applyModuleCleanupPasses = (statements: t.Statement[]): t.Statement[] => {
    // Pass E — collapse Babel slicedToArray expansions.
    const afterE = collapseSlicedToArrayDeep(statements);

    // Pass F — JSX recovery.
    recoverJSX(afterE);

    // Pass G — remove top-level Babel helper functions and webpack module-cache vars.
    const afterG = dropEmptyObjectVars(
        afterE.filter(
            (stmt) =>
                !isBabelArrayLikeToArrayHelper(stmt) &&
                !isBabelTypeofHelper(stmt) &&
                !isBabelDefinePropertyHelper(stmt) &&
                !isBabelObjectSpreadHelper(stmt) &&
                !isBabelObjectSpread2Helper(stmt) &&
                !isBabelOwnKeysHelper(stmt) &&
                !isNamedBabelArrayHelper(stmt)
        )
    );

    return afterG;
};

// ---------------------------------------------------------------------------
// Route-aware component renaming
// ---------------------------------------------------------------------------

/** Derives a component name from a React Router path string. */
function pathToComponentName(fullPath: string): string {
    if (fullPath === "/" || fullPath === "") return "Home";
    const isIndex = fullPath.endsWith("/index");
    const base = isIndex ? fullPath.slice(0, -"/index".length) : fullPath;
    const segments = base
        .replace(/^\//, "")
        .split("/")
        .filter((s) => s && !s.startsWith(":"));
    if (segments.length === 0) return "Home";
    const name = segments
        .map((s) => s.charAt(0).toUpperCase() + s.slice(1).replace(/-(\w)/g, (_, c: string) => c.toUpperCase()))
        .join("");
    return isIndex ? `${name}Dashboard` : name;
}

/**
 * Post-pass that renames minified component variables to meaningful names derived
 * from React Router route paths. Intended to run after JSX recovery (Pass F) so
 * that `<Route path="..." element={<X />} />` patterns are visible as JSX.
 *
 * Also renames:
 *   - The root App component (the one that contains `<Routes>`)
 *   - The Suspense fallback component (if it's a locally-defined function)
 */
export const renameRouteComponents = (statements: t.Statement[]): t.Statement[] => {
    // Step 1: collect lazy-import variable names → spec (e.g. '_' → './45.js')
    const lazyVars = new Map<string, string>(); // varName → importSpec
    for (const stmt of statements) {
        if (!t.isVariableDeclaration(stmt)) continue;
        for (const decl of stmt.declarations) {
            if (!t.isIdentifier(decl.id) || !decl.init) continue;
            if (!t.isCallExpression(decl.init)) continue;
            const callExpr = decl.init as t.CallExpression;
            if (!t.isIdentifier(callExpr.callee, { name: "lazy" })) continue;
            if (callExpr.arguments.length !== 1) continue;
            const arg = callExpr.arguments[0];
            if (!t.isArrowFunctionExpression(arg) && !t.isFunctionExpression(arg)) continue;
            const body = (arg as t.ArrowFunctionExpression | t.FunctionExpression).body;
            // body is `import('./N.js')` — an ImportExpression node
            const importCall = t.isBlockStatement(body)
                ? (body as t.BlockStatement).body.length === 1 &&
                  t.isReturnStatement((body as t.BlockStatement).body[0])
                    ? ((body as t.BlockStatement).body[0] as t.ReturnStatement).argument
                    : null
                : (body as t.Expression);
            if (!importCall || !t.isImportExpression(importCall)) continue;
            if (!t.isStringLiteral(importCall.source)) continue;
            lazyVars.set((decl.id as t.Identifier).name, importCall.source.value);
        }
    }

    if (lazyVars.size === 0) return statements;

    // Step 2: traverse JSX Route elements, tracking parent route paths for full-path assembly.
    const varToPath = new Map<string, string>(); // varName → full route path
    const syntheticFile = t.file(t.program(statements as t.Statement[], [], "module"));

    const pathStack: string[] = [];
    traverse(syntheticFile, {
        JSXElement: {
            enter(p) {
                const opening = p.node.openingElement;
                if (!t.isJSXIdentifier(opening.name, { name: "Route" })) return;

                let routePath: string | null = null;
                let isIndex = false;
                let elementVarName: string | null = null;

                for (const attr of opening.attributes) {
                    if (!t.isJSXAttribute(attr)) continue;
                    const keyName = t.isJSXIdentifier(attr.name) ? (attr.name as t.JSXIdentifier).name : null;
                    if (keyName === "path" && t.isStringLiteral(attr.value)) {
                        routePath = (attr.value as t.StringLiteral).value;
                    } else if (keyName === "index") {
                        isIndex = true;
                    } else if (keyName === "element") {
                        const val = attr.value;
                        const jsxEl = t.isJSXExpressionContainer(val)
                            ? t.isJSXElement((val as t.JSXExpressionContainer).expression)
                                ? ((val as t.JSXExpressionContainer).expression as t.JSXElement)
                                : null
                            : t.isJSXElement(val)
                              ? (val as t.JSXElement)
                              : null;
                        if (jsxEl) {
                            const tagName = jsxEl.openingElement.name;
                            if (t.isJSXIdentifier(tagName)) elementVarName = (tagName as t.JSXIdentifier).name;
                        }
                    }
                }

                const parentPath = pathStack.length > 0 ? pathStack[pathStack.length - 1] : "";
                let fullPath: string;
                if (routePath !== null) {
                    fullPath = routePath.startsWith("/") ? routePath : `${parentPath}/${routePath}`;
                } else if (isIndex) {
                    fullPath = `${parentPath}/index`;
                } else {
                    fullPath = parentPath;
                }
                pathStack.push(fullPath);

                if (elementVarName && lazyVars.has(elementVarName)) {
                    varToPath.set(elementVarName, fullPath);
                }
            },
            exit(p) {
                if (t.isJSXIdentifier(p.node.openingElement.name, { name: "Route" })) {
                    pathStack.pop();
                }
            },
        },
    });

    // Step 3: generate semantic names from route paths
    const renames = new Map<string, string>(); // oldName → newName
    const usedNames = new Set<string>();

    for (const [varName, fullPath] of varToPath) {
        let name = pathToComponentName(fullPath);
        if (usedNames.has(name)) {
            let i = 2;
            while (usedNames.has(`${name}${i}`)) i++;
            name = `${name}${i}`;
        }
        usedNames.add(name);
        renames.set(varName, name);
    }

    // Step 4: find the root App component — the function whose JSX body contains <Routes>
    traverse(syntheticFile, {
        JSXElement(p) {
            if (!t.isJSXIdentifier(p.node.openingElement.name, { name: "Routes" })) return;
            let ancestor: NodePath | null = p.parentPath;
            while (ancestor) {
                if (
                    ancestor.isFunctionDeclaration() ||
                    ancestor.isFunctionExpression() ||
                    ancestor.isArrowFunctionExpression()
                ) {
                    if (ancestor.isFunctionDeclaration()) {
                        const id = (ancestor.node as t.FunctionDeclaration).id;
                        if (id && !renames.has(id.name)) renames.set(id.name, "App");
                    } else {
                        const par = ancestor.parentPath;
                        if (par?.isVariableDeclarator()) {
                            const declId = (par.node as t.VariableDeclarator).id;
                            if (t.isIdentifier(declId) && !renames.has((declId as t.Identifier).name)) {
                                renames.set((declId as t.Identifier).name, "App");
                            }
                        }
                    }
                    break;
                }
                if (!ancestor.parentPath) break;
                ancestor = ancestor.parentPath;
            }
            p.skip();
        },
    });

    // Step 5: find the Suspense fallback component
    traverse(syntheticFile, {
        JSXAttribute(p) {
            if (!t.isJSXIdentifier(p.node.name, { name: "fallback" })) return;
            const val = p.node.value;
            if (!t.isJSXExpressionContainer(val)) return;
            const expr = (val as t.JSXExpressionContainer).expression;
            if (!t.isJSXElement(expr)) return;
            const tagName = (expr as t.JSXElement).openingElement.name;
            if (!t.isJSXIdentifier(tagName)) return;
            const varName = (tagName as t.JSXIdentifier).name;
            if (!renames.has(varName) && !lazyVars.has(varName)) {
                renames.set(varName, "Loading");
            }
        },
    });

    if (renames.size === 0) return statements;

    // Step 6: rename bindings via scope analysis, then patch any remaining JSXIdentifiers
    traverse(syntheticFile, {
        Program(p) {
            for (const [oldName, newName] of renames) {
                if (p.scope.hasBinding(oldName)) {
                    p.scope.rename(oldName, newName);
                }
            }
        },
    });
    // JSXIdentifier nodes may not be tracked by scope — patch them explicitly as a fallback
    traverse(syntheticFile, {
        JSXIdentifier(p) {
            const newName = renames.get(p.node.name);
            if (newName) p.node.name = newName;
        },
    });

    return statements;
};

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Transforms the non-module-map IIFE statements that become `index.js`.
 *
 * Passes:
 *   A – Remove webpack require helper function.
 *   B – Hoist top-level `var x = requireFn(N)` to static `import * as x from "./N.js"`.
 *   C – Replace remaining inline `requireFn(N)` calls.
 *   D – Rewrite library module calls using identity map (e.g. `l.H(...)` → `createRoot(...)`)
 *       and replace namespace imports with named imports from proper library paths.
 *   E – Collapse Babel slicedToArray expansions to `const [a, b] = expr`.
 *   F – Recover JSX from `jsx(tag, props)` / `jsxs(tag, props)` calls.
 *   G – Remove Babel array-helper functions (e.g. `arrayLikeToArray`).
 */
export const transformIndexStatements = (
    statements: t.Statement[],
    libModuleMap?: Map<string, LibraryModuleInfo>
): t.Statement[] => {
    // Pass A — detect and remove webpack require helper(s).
    const requireFnNames = new Set<string>();
    const afterA: t.Statement[] = [];
    for (const stmt of statements) {
        if (t.isFunctionDeclaration(stmt) && stmt.id && isWebpackRequireHelper(stmt as t.FunctionDeclaration)) {
            requireFnNames.add((stmt.id as t.Identifier).name);
            continue; // drop
        }
        afterA.push(stmt);
    }

    if (requireFnNames.size === 0) return statements; // nothing to do

    // Pass A.1 — strip webpack runtime bootstrap statements.
    // Any statement that references requireFn.X (assignments, calls, or var inits)
    // is webpack infrastructure.  Also strip the runtime temp-var declarations that
    // have no init / empty-collection init and 3+ declarators.
    const containsRequireFnMember = (node: t.Node, fnName: string): boolean => {
        if (t.isMemberExpression(node) && t.isIdentifier((node as t.MemberExpression).object, { name: fnName }))
            return true;
        for (const key of Object.keys(node)) {
            const child = (node as unknown as Record<string, unknown>)[key];
            if (child && typeof child === "object") {
                if (Array.isArray(child)) {
                    for (const item of child) {
                        if (
                            item &&
                            typeof (item as unknown as Record<string, unknown>).type === "string" &&
                            containsRequireFnMember(item as t.Node, fnName)
                        )
                            return true;
                    }
                } else if (typeof (child as unknown as Record<string, unknown>).type === "string") {
                    if (containsRequireFnMember(child as t.Node, fnName)) return true;
                }
            }
        }
        return false;
    };
    const isRuntimeTempVarDecl = (stmt: t.Statement): boolean => {
        if (!t.isVariableDeclaration(stmt) || stmt.declarations.length < 3) return false;
        return stmt.declarations.every((decl) => {
            if (!decl.init) return true;
            if (t.isObjectExpression(decl.init) && (decl.init as t.ObjectExpression).properties.length === 0)
                return true;
            if (t.isArrayExpression(decl.init) && (decl.init as t.ArrayExpression).elements.length === 0) return true;
            if (t.isUnaryExpression(decl.init) && (decl.init as t.UnaryExpression).operator === "void") return true;
            return false;
        });
    };
    const afterA1: t.Statement[] = [];
    for (const stmt of afterA) {
        let isRuntime = isRuntimeTempVarDecl(stmt);
        if (!isRuntime) {
            for (const fnName of requireFnNames) {
                if (containsRequireFnMember(stmt, fnName)) {
                    isRuntime = true;
                    break;
                }
            }
        }
        if (!isRuntime) afterA1.push(stmt);
    }

    const hoistedImports = new Map<string, string>();
    const importNameByNumId = new Map<number, string>();

    // Pass B — hoist top-level `var x = requireFn(N)` to static imports.
    // Also build varName → moduleId so Pass D can look up library identity.
    const varToModuleId = new Map<string, number>(); // localVarName → numericModuleId

    const afterB: t.Statement[] = [];
    for (const stmt of afterA1) {
        if (!t.isVariableDeclaration(stmt)) {
            afterB.push(stmt);
            continue;
        }
        const kept: t.VariableDeclarator[] = [];
        for (const decl of stmt.declarations) {
            if (!t.isIdentifier(decl.id) || !decl.init) {
                kept.push(decl);
                continue;
            }
            let matched = false;
            for (const fnName of requireFnNames) {
                const numId = tryExtractRequireCall(decl.init, fnName);
                if (numId === null) continue;
                const spec = `./${numId}.js`;
                const localName = (decl.id as t.Identifier).name;
                if (!hoistedImports.has(spec)) {
                    hoistedImports.set(spec, localName);
                    importNameByNumId.set(numId, localName);
                }
                varToModuleId.set(localName, numId);
                matched = true;
                break;
            }
            if (!matched) kept.push(decl);
        }
        if (kept.length > 0) afterB.push(t.variableDeclaration(stmt.kind, kept));
    }

    // Pass C — replace remaining inline requireFn(N) calls recursively.
    const syntheticFile = t.file(t.program(afterB, [], "module"));
    traverse(syntheticFile, {
        CallExpression(p) {
            for (const fnName of requireFnNames) {
                const numId = tryExtractRequireCall(p.node, fnName);
                if (numId === null) continue;
                let name = importNameByNumId.get(numId);
                if (!name) {
                    name = `_jsr_module_${numId}`;
                    hoistedImports.set(`./${numId}.js`, name);
                    importNameByNumId.set(numId, name);
                }
                p.replaceWith(t.identifier(name));
                p.skip();
                break;
            }
        },
    });

    // Pass D — library-aware import rewriting (only when libModuleMap is supplied).
    // Build varName → LibraryModuleInfo, then rewrite calls and imports.
    const finalImportStmts: t.Statement[] = [];

    if (libModuleMap && libModuleMap.size > 0) {
        // Map local var names to their library identity
        const varToLib = new Map<string, LibraryModuleInfo>();
        for (const [varName, numId] of varToModuleId) {
            const info = libModuleMap.get(String(numId));
            if (info) varToLib.set(varName, info);
        }

        if (varToLib.size > 0) {
            // Rewrite call-sites; collect which named exports are actually used
            const usedExports = rewriteLibraryCalls(afterB, varToLib);

            // Build import declarations for library modules (named imports).
            // handledSpecs guards only the import-declaration emit (avoid duplicates when
            // two local vars map to the same library source). The namespace-import deletion
            // must happen for EVERY var that maps to a library, regardless of dedup.
            const handledSpecs = new Set<string>();
            for (const [varName, info] of varToLib) {
                const src = librarySource(info.type);
                if (!src) continue;
                if (!handledSpecs.has(src)) {
                    handledSpecs.add(src);
                    const used = usedExports.get(src);
                    if (used && used.size > 0) {
                        const specifiers = [...used]
                            .sort()
                            .map((name) => t.importSpecifier(t.identifier(name), t.identifier(name)));
                        finalImportStmts.push(t.importDeclaration(specifiers, t.stringLiteral(src)));
                    }
                }
                // Always remove the namespace import for this var, even if src was already handled.
                const numId = varToModuleId.get(varName);
                if (numId !== undefined) hoistedImports.delete(`./${numId}.js`);
            }
        }
    }

    // Remaining (non-library) namespace imports
    for (const [spec, name] of hoistedImports) {
        finalImportStmts.push(
            t.importDeclaration([t.importNamespaceSpecifier(t.identifier(name))], t.stringLiteral(spec))
        );
    }

    // Pass E — collapse Babel slicedToArray expansions.
    const afterE = collapseSlicedToArrayDeep(afterB);

    // Pass F — JSX recovery.
    recoverJSX(afterE);

    // Pass G — remove top-level Babel helper functions and webpack module-cache vars.
    const afterG = dropEmptyObjectVars(
        afterE.filter(
            (stmt) =>
                !isBabelArrayLikeToArrayHelper(stmt) &&
                !isBabelTypeofHelper(stmt) &&
                !isBabelDefinePropertyHelper(stmt) &&
                !isBabelObjectSpreadHelper(stmt) &&
                !isBabelObjectSpread2Helper(stmt) &&
                !isBabelOwnKeysHelper(stmt) &&
                !isNamedBabelArrayHelper(stmt)
        )
    );

    // Pass H — prune named imports whose local name is no longer referenced
    //           (e.g. jsx/jsxs after JSX recovery, namespace imports that were cleared).
    const prunedImports = pruneUnusedNamedImports(finalImportStmts, afterG);

    return [...prunedImports, ...afterG];
};
