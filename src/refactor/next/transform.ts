import { NodePath } from "@babel/traverse";
import _traverse from "@babel/traverse";
import _generator from "@babel/generator";
import * as t from "@babel/types";
import {
    tryExtractTurbopackRequire,
    tryExtractWebpackRequire,
    tryExtractRuntimeSExport,
    tryExtractDefinePropertyExport,
    tryExtractBatchIIFEExports,
    tryExtractRequireDotD,
    isRequireDotR,
    isEsModuleMarker,
    isInteropBoilerplate,
    tryExtractModuleExportsRhs,
    tryExtractForInExportLoop,
    extractExportsFromMap,
    makeExportStatement,
} from "./helpers.js";

const traverse = (_traverse.default ?? _traverse) as typeof _traverse.default;
const generate = _generator.default;

// Turbopack module format: func_NNN = (runtime, module, exports) => { ... }
// - runtime (params[0]): turbopack runtime — runtime.r(N) / runtime.i(N) for imports
// - module  (params[1]): module object — module.exports = ... interop boilerplate
// - exports (params[2]): exports target — ODP(exports,"name",{get:fn}) sets named exports
export type TurboModuleEntry = {
    id: string;
    fnPath: NodePath<t.ArrowFunctionExpression | t.FunctionExpression>;
    runtimeParam: string; // first param  — runtime with .r(N)/.i(N) for requires
    moduleParam: string; // second param — module object with .exports
    exportsParam: string; // third param  — exports target for ODP
    requireParam: string; // webpack-style require param (empty for pure turbopack chunks)
};

// Webpack-style module format: NNN: (module, exports, require) => { r.d(t, {...}), r.r(t), ... }
// Uses require.d / require.r for export registration.
// Accepts ArrowFunctionExpression (webpack 5), FunctionExpression (webpack 4/Vue CLI), and
// FunctionDeclaration (`function webpack_<id>(...)`, synthesized by getWebpackConnections.ts
// for chunks whose original module was itself a `function` expression).
export type WebpackModuleEntry = {
    id: string;
    fnPath: NodePath<t.ArrowFunctionExpression | t.FunctionExpression | t.FunctionDeclaration>;
    runtimeParam: string; // empty for webpack-style
    moduleParam: string;
    exportsParam: string;
    requireParam: string; // third param — require with .d() and .r()
};

// ---------------------------------------------------------------------------
// Pass F — JSX recovery
// ---------------------------------------------------------------------------

function exprToJsxName(expr: t.Expression): t.JSXIdentifier | t.JSXMemberExpression | null {
    if (t.isStringLiteral(expr)) return t.jsxIdentifier(expr.value);
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

// JSXText is emitted verbatim by the generator — it is not escaped the way a JS string
// literal would be. A child string containing `<`, `>`, `{`, or `}` (e.g. a code sample
// like "<script>") would be re-parsed as JSX markup and break the tree, so any child
// containing those characters must stay wrapped in an expression container instead.
const isSafeAsJsxText = (value: string): boolean => !/[<>{}]/.test(value);

function childToJsxChild(
    child: t.Expression
): t.JSXElement | t.JSXFragment | t.JSXText | t.JSXExpressionContainer | t.JSXSpreadChild | null {
    if (t.isStringLiteral(child)) {
        return isSafeAsJsxText(child.value) ? t.jsxText(child.value) : t.jsxExpressionContainer(child);
    }
    if (t.isTemplateLiteral(child) && child.expressions.length === 0 && child.quasis.length === 1) {
        const raw = child.quasis[0].value.cooked ?? child.quasis[0].value.raw;
        if (raw !== undefined) {
            return isSafeAsJsxText(raw) ? t.jsxText(raw) : t.jsxExpressionContainer(child);
        }
    }
    if (t.isJSXElement(child) || t.isJSXFragment(child)) return child;
    if (t.isCallExpression(child)) {
        const converted = tryConvertToJSX(child);
        if (converted) return converted;
    }
    return t.jsxExpressionContainer(child);
}

function tryUnpackSpreadIIFE(expr: t.Expression): { base: t.Expression; spreads: t.Expression[] } | null {
    if (!t.isCallExpression(expr)) return null;
    const callee = expr.callee;
    if (!t.isFunctionExpression(callee)) return null;
    if (callee.params.length !== 1 || !t.isIdentifier(callee.params[0])) return null;
    const paramName = (callee.params[0] as t.Identifier).name;
    const body = callee.body.body;
    if (body.length < 2) return null;
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
    const hasReturn = body.some(
        (s) => t.isReturnStatement(s) && s.argument && t.isIdentifier(s.argument, { name: paramName })
    );
    if (!hasReturn) return null;
    const args = expr.arguments as t.Expression[];
    if (args.length < 1) return null;
    return { base: args[0], spreads: args.slice(1) };
}

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
            attrs.push(t.jsxSpreadAttribute(propsArg));
        }
    }

    return { attrs, childExprs };
}

const JSX_METHOD_NAMES = new Set(["jsx", "jsxs", "jsxDEV"]);

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

    if (t.isJSXIdentifier(jsxName) && jsxName.name === "Fragment") {
        return t.jsxFragment(t.jsxOpeningFragment(), t.jsxClosingFragment(), children);
    }

    const jsxAttrs = attrs.filter(
        (a): a is t.JSXAttribute | t.JSXSpreadAttribute => t.isJSXAttribute(a) || t.isJSXSpreadAttribute(a)
    );
    const selfClosing = children.length === 0;
    const openingElement = t.jsxOpeningElement(jsxName, jsxAttrs, selfClosing);
    const closingElement = selfClosing ? null : t.jsxClosingElement(jsxName);

    return t.jsxElement(openingElement, closingElement, children, selfClosing);
}

function recoverJSX(statements: t.Statement[]): void {
    const syntheticFile = t.file(t.program(statements, [], "module"));
    traverse(syntheticFile, {
        CallExpression(p) {
            const jsxEl = tryConvertToJSX(p.node);
            if (!jsxEl) return;
            p.replaceWith(jsxEl);
        },
    });
}

// ---------------------------------------------------------------------------
// Pass E — Babel slicedToArray collapse
// ---------------------------------------------------------------------------

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
        if (!t.isAssignmentExpression(exprs[0]) || (exprs[0] as t.AssignmentExpression).operator !== "=") continue;
        const firstAssign = exprs[0] as t.AssignmentExpression;
        if (!t.isIdentifier(firstAssign.left)) continue;
        if (!t.isAssignmentExpression(exprs[1]) || !t.isNumericLiteral((exprs[1] as t.AssignmentExpression).right))
            continue;
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

function collapseSlicedToArray(statements: t.Statement[]): t.Statement[] {
    const out: t.Statement[] = [];
    for (const stmt of statements) {
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
        const sorted = [...targets].sort((a, b) => a.index - b.index);
        const pattern = t.arrayPattern(sorted.map((tgt) => tgt.id as unknown as t.PatternLike));
        out.push(t.variableDeclaration("const", [t.variableDeclarator(pattern, actualExpr)]));
    }
    return out;
}

function isNamedSlicedToArrayHelper(stmt: t.Statement): string | null {
    if (!t.isFunctionDeclaration(stmt) || !stmt.id || stmt.params.length !== 2) return null;
    if (stmt.id.name === "_slicedToArray" || stmt.id.name === "slicedToArray") return stmt.id.name;
    const body = stmt.body.body;
    if (body.length === 0) return null;
    const last = body[body.length - 1];
    if (!t.isReturnStatement(last) || !last.argument) return null;
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
            if (
                t.isIdentifier(actualExpr) &&
                newDecls.length > 0 &&
                t.isIdentifier(newDecls[newDecls.length - 1].id) &&
                (newDecls[newDecls.length - 1].id as t.Identifier).name === (actualExpr as t.Identifier).name &&
                newDecls[newDecls.length - 1].init != null
            ) {
                actualExpr = newDecls[newDecls.length - 1].init as t.Expression;
                newDecls.pop();
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

function collapseNamedSlicedToArray(statements: t.Statement[]): t.Statement[] {
    const helperNames = new Set<string>();
    for (const stmt of statements) {
        const name = isNamedSlicedToArrayHelper(stmt);
        if (name) helperNames.add(name);
    }
    if (helperNames.size === 0) return statements;

    const withoutHelpers = statements.filter(
        (s) => !(t.isFunctionDeclaration(s) && s.id && helperNames.has(s.id.name))
    );
    const topCollapsed = collapseSlicedToArrayCalls(withoutHelpers, helperNames);

    const syntheticFile = t.file(t.program(topCollapsed, [], "module"));
    traverse(syntheticFile, {
        BlockStatement(p) {
            const collapsed = collapseSlicedToArrayCalls(p.node.body, helperNames);
            if (collapsed !== p.node.body) p.node.body = collapsed;
        },
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

function collapseSlicedToArrayDeep(statements: t.Statement[]): t.Statement[] {
    const afterNamed = collapseNamedSlicedToArray(statements);
    const top = collapseSlicedToArray(afterNamed);
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
// Pass G — remove Babel helpers
// ---------------------------------------------------------------------------

function isBabelArrayLikeToArrayHelper(stmt: t.Statement): boolean {
    if (!t.isFunctionDeclaration(stmt) || !stmt.id) return false;
    const body = stmt.body.body;
    if (body.length < 2 || body.length > 4) return false;
    return body.some((s) => {
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
}

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

function isBabelObjectSpreadHelper(stmt: t.Statement): boolean {
    if (!t.isFunctionDeclaration(stmt) || !stmt.id || stmt.params.length !== 2) return false;
    const body = stmt.body.body;
    if (body.length < 2) return false;
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
    return JSON.stringify(body).includes('"getOwnPropertySymbols"');
}

function isBabelObjectSpread2Helper(stmt: t.Statement): boolean {
    if (!t.isFunctionDeclaration(stmt)) return false;
    if (stmt.params.length !== 1) return false;
    const body = stmt.body.body;
    const hasArgumentsLength = JSON.stringify(body).includes('"arguments"');
    const hasDefineProperties =
        JSON.stringify(body).includes('"defineProperties"') || JSON.stringify(body).includes('"defineProperty"');
    return hasArgumentsLength && hasDefineProperties;
}

function isBabelOwnKeysHelper(stmt: t.Statement): boolean {
    if (!t.isFunctionDeclaration(stmt)) return false;
    const params = stmt.params;
    if (params.length < 1 || params.length > 2) return false;
    const body = stmt.body.body;
    if (body.length === 0) return false;
    const first = body[0];
    if (!t.isVariableDeclaration(first)) return false;
    const bodyStr = JSON.stringify(body);
    return bodyStr.includes('"keys"') && bodyStr.includes('"getOwnPropertySymbols"');
}

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

function removeBabelHelpers(stmts: t.Statement[]): t.Statement[] {
    return stmts.filter(
        (s) =>
            !isBabelArrayLikeToArrayHelper(s) &&
            !isBabelTypeofHelper(s) &&
            !isBabelDefinePropertyHelper(s) &&
            !isBabelObjectSpreadHelper(s) &&
            !isBabelObjectSpread2Helper(s) &&
            !isBabelOwnKeysHelper(s) &&
            !isNamedBabelArrayHelper(s)
    );
}

// ---------------------------------------------------------------------------
// Pass H — prune unused named imports
// ---------------------------------------------------------------------------

function collectReferencedNames(stmts: t.Statement[]): Set<string> {
    const names = new Set<string>();
    const syntheticFile = t.file(t.program(stmts, [], "module"));
    traverse(syntheticFile, {
        Identifier(p) {
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
            names.add(p.node.name);
        },
    });
    return names;
}

function pruneUnusedNamedImports(importStmts: t.Statement[], bodyStmts: t.Statement[]): t.Statement[] {
    const refs = collectReferencedNames(bodyStmts);
    return importStmts
        .map((stmt) => {
            if (!t.isImportDeclaration(stmt)) return stmt;
            // Side-effect imports (no specifiers) are always kept.
            if (stmt.specifiers.length === 0) return stmt;
            const prunedSpecifiers = stmt.specifiers.filter((spec) => {
                if (t.isImportNamespaceSpecifier(spec)) return true;
                if (t.isImportDefaultSpecifier(spec)) return true;
                if (t.isImportSpecifier(spec)) {
                    const localName = t.isIdentifier(spec.local) ? spec.local.name : null;
                    return localName ? refs.has(localName) : true;
                }
                return true;
            });
            if (prunedSpecifiers.length === 0) return null;
            if (prunedSpecifiers.length === stmt.specifiers.length) return stmt;
            return t.importDeclaration(prunedSpecifiers, stmt.source);
        })
        .filter(Boolean) as t.Statement[];
}

// ---------------------------------------------------------------------------
// Core transform: turbopack module format
// ---------------------------------------------------------------------------

/**
 * Transforms a single Turbopack (or webpack-style) module arrow function into ECMAScript statements.
 *
 * Passes:
 *   1.  Collect exports:
 *         - ODP(exportsParam, "name", {get:fn}) — direct named export
 *         - for-in loop over an object of getters → named exports
 *         - IIFE batch: !(fn)(exportsParam, {name:getter,...}) → named exports
 *         - runtimeParam.s(["name", 0, fn]) → default/named export (1-param turbopack)
 *         - requireParam.d(exportsParam, {...}) → named exports (webpack-style only)
 *       Also drops: __esModule markers, require.r(exports), "use strict", interop boilerplate.
 *   2.  Hoist: `var x = runtimeParam.r(N)` / `var x = runtimeParam.i(N)` → `import * as x`.
 *       Side-effect runtimeParam.r(N) in sequence expressions → `import "./N.js"`.
 *   3.  Replace remaining inline runtimeParam.r(N) / runtimeParam.i(N) calls with identifiers.
 *   E.  Collapse Babel slicedToArray expansions.
 *   F.  Recover JSX from jsx()/jsxs() calls (runs on both body and export statements).
 *   G.  Remove Babel helpers.
 *   H.  Prune unused named imports.
 *   4.  Assemble: prepend imports, keep filtered body, append export declarations.
 */
export const transformModule = (mod: TurboModuleEntry): t.Statement[] => {
    const { fnPath, runtimeParam, moduleParam, exportsParam, requireParam } = mod;
    const body = fnPath.node.body;
    if (!t.isBlockStatement(body)) return [];

    // webpack-style: no turbopack runtime, direct requireParam(N) calls
    const isWebpackStyle = !runtimeParam && !!requireParam;

    // ── Pre-scan: find for-in export loops ────────────────────────────────
    const exportMapVarNames = new Set<string>();
    const exportMapDeclNodes = new Map<string, t.VariableDeclaration>();

    for (const stmt of body.body) {
        const mapVarName = tryExtractForInExportLoop(stmt, exportsParam);
        if (mapVarName !== null) exportMapVarNames.add(mapVarName);
    }
    for (const stmt of body.body) {
        if (!t.isVariableDeclaration(stmt)) continue;
        for (const decl of stmt.declarations) {
            if (
                t.isIdentifier(decl.id) &&
                exportMapVarNames.has((decl.id as t.Identifier).name) &&
                decl.init &&
                t.isObjectExpression(decl.init)
            ) {
                exportMapDeclNodes.set((decl.id as t.Identifier).name, stmt);
            }
        }
    }

    // ── Pass 1: collect exports + mark for removal ────────────────────────
    const exportMap = new Map<string, t.Expression>();
    const stmtsToRemove = new WeakSet<t.Statement>();

    // Collect side-effect requires from sequence expressions (e.g. (ODP, r(N1), r(N2)))
    const sideEffectRequireIds = new Set<number>();
    // Webpack CJS re-exports: e.exports = r(N) → export * from './N.js'
    const reExportIds = new Set<number>();

    for (const stmt of body.body) {
        // Drop "use strict" directives (they become expressions in lax parse mode)
        if (
            t.isExpressionStatement(stmt) &&
            t.isStringLiteral(stmt.expression) &&
            (stmt.expression as t.StringLiteral).value === "use strict"
        ) {
            stmtsToRemove.add(stmt);
            continue;
        }

        // moduleParam.exports = X handling
        if (moduleParam) {
            // Step 1: handle simple top-level e.exports = VALUE assignments
            const cjsRhs = tryExtractModuleExportsRhs(stmt, moduleParam);
            if (cjsRhs !== null) {
                stmtsToRemove.add(stmt);
                // Pure interop: e.exports = exportsParam.default → strip silently
                if (
                    exportsParam &&
                    t.isMemberExpression(cjsRhs) &&
                    !(cjsRhs as t.MemberExpression).computed &&
                    t.isIdentifier((cjsRhs as t.MemberExpression).object, { name: exportsParam }) &&
                    t.isIdentifier((cjsRhs as t.MemberExpression).property, { name: "default" })
                ) {
                    continue;
                }
                // Not turbopack (no runtimeParam): this is an actual CJS export
                if (!runtimeParam) {
                    // e.exports = requireParam(N) → re-export all from N
                    if (requireParam) {
                        const reExportId = tryExtractWebpackRequire(cjsRhs, requireParam);
                        if (reExportId !== null) {
                            reExportIds.add(reExportId);
                            continue;
                        }
                    }
                    // e.exports = VALUE → export default VALUE
                    exportMap.set("default", cjsRhs);
                }
                continue;
            }

            // Step 2: strip complex nested interop patterns (e.g. conditional with module.exports=exports.default inside).
            // Only applies when exportsParam is known (2-/3-param modules) — 1-param modules have no
            // exports param so any e.exports=X might be a real CJS export, not interop.
            // Also skip SequenceExpression statements — their sub-expressions are handled element-by-element below.
            if (
                exportsParam &&
                (!t.isExpressionStatement(stmt) || !t.isSequenceExpression((stmt as t.ExpressionStatement).expression))
            ) {
                if (isInteropBoilerplate(stmt, moduleParam, exportsParam)) {
                    stmtsToRemove.add(stmt);
                    continue;
                }
            }
        }

        if (t.isExpressionStatement(stmt)) {
            const expr = stmt.expression;

            // `Object.defineProperty(exportsParam, "__esModule", …)` — interop marker
            if (isEsModuleMarker(expr, exportsParam)) {
                stmtsToRemove.add(stmt);
                continue;
            }

            // Direct `Object.defineProperty(exportsParam, "name", { get: fn })`
            const direct = tryExtractDefinePropertyExport(expr, exportsParam);
            if (direct) {
                exportMap.set(direct.exportName, direct.returnExpr);
                stmtsToRemove.add(stmt);
                continue;
            }

            // Turbopack IIFE batch export: !(fn)(exportsParam, {name:getter,...})
            const batchExports = tryExtractBatchIIFEExports(expr, exportsParam);
            if (batchExports) {
                for (const [name, retExpr] of batchExports) exportMap.set(name, retExpr);
                stmtsToRemove.add(stmt);
                continue;
            }

            // Turbopack 1-param: runtimeParam.s(["name", 0, fn]) → export
            if (runtimeParam) {
                const sExport = tryExtractRuntimeSExport(expr, runtimeParam);
                if (sExport) {
                    exportMap.set(sExport.exportName, sExport.exportFn);
                    stmtsToRemove.add(stmt);
                    continue;
                }
            }

            // webpack requireParam.r(exportsParam) → drop (Pass 1.5)
            if (requireParam && isRequireDotR(expr, requireParam, exportsParam)) {
                stmtsToRemove.add(stmt);
                continue;
            }

            // webpack requireParam.d(exportsParam, {...}) → named exports (Pass 1.5)
            if (requireParam) {
                const dotDExports = tryExtractRequireDotD(expr, requireParam, exportsParam);
                if (dotDExports) {
                    for (const [name, retExpr] of dotDExports) exportMap.set(name, retExpr);
                    stmtsToRemove.add(stmt);
                    continue;
                }
            }

            // Webpack standalone side-effect require: r(N); as a lone expression statement
            if (isWebpackStyle && requireParam) {
                const sideEffectId = tryExtractWebpackRequire(expr, requireParam);
                if (sideEffectId !== null) {
                    sideEffectRequireIds.add(sideEffectId);
                    stmtsToRemove.add(stmt);
                    continue;
                }
            }

            // SequenceExpression: handle (ODP, !(fn)(...), r(N1), r(N2), ...) mixed sequences
            if (t.isSequenceExpression(expr)) {
                const kept: t.Expression[] = [];
                for (const sub of expr.expressions) {
                    if (isEsModuleMarker(sub, exportsParam)) continue;

                    const directSub = tryExtractDefinePropertyExport(sub, exportsParam);
                    if (directSub) {
                        exportMap.set(directSub.exportName, directSub.returnExpr);
                        continue;
                    }

                    const batchSub = tryExtractBatchIIFEExports(sub, exportsParam);
                    if (batchSub) {
                        for (const [name, retExpr] of batchSub) exportMap.set(name, retExpr);
                        continue;
                    }

                    if (requireParam && isRequireDotR(sub, requireParam, exportsParam)) continue;

                    if (requireParam) {
                        const dotDSub = tryExtractRequireDotD(sub, requireParam, exportsParam);
                        if (dotDSub) {
                            for (const [name, retExpr] of dotDSub) exportMap.set(name, retExpr);
                            continue;
                        }
                    }

                    // Side-effect require: runtime.r(N) / runtime.i(N) standalone in a sequence
                    if (runtimeParam) {
                        const sideEffectId = tryExtractTurbopackRequire(sub, runtimeParam);
                        if (sideEffectId !== null) {
                            sideEffectRequireIds.add(sideEffectId);
                            continue;
                        }
                    }

                    // Webpack side-effect require: requireParam(N) standalone in a sequence
                    if (isWebpackStyle && requireParam) {
                        const sideEffectId = tryExtractWebpackRequire(sub, requireParam);
                        if (sideEffectId !== null) {
                            sideEffectRequireIds.add(sideEffectId);
                            continue;
                        }
                    }

                    // Strip complex interop boilerplate sub-expressions in a sequence
                    // (e.g. `("function"==typeof t.default||...)&&e.exports=t.default`)
                    if (
                        moduleParam &&
                        exportsParam &&
                        isInteropBoilerplate(t.expressionStatement(sub), moduleParam, exportsParam)
                    )
                        continue;

                    kept.push(sub);
                }

                if (kept.length === 0) {
                    stmtsToRemove.add(stmt);
                } else if (kept.length < expr.expressions.length) {
                    (stmt as t.ExpressionStatement).expression =
                        kept.length === 1 ? kept[0] : t.sequenceExpression(kept);
                }
                continue;
            }
        }

        // ForInStatement: `for (var k in mapVar) ODP(exportsParam, k, ...)` (rare direct form)
        const mapVarName = tryExtractForInExportLoop(stmt, exportsParam);
        if (mapVarName !== null) {
            stmtsToRemove.add(stmt);
            const declNode = exportMapDeclNodes.get(mapVarName);
            if (declNode) {
                for (const decl of declNode.declarations) {
                    if (t.isIdentifier(decl.id, { name: mapVarName }) && decl.init && t.isObjectExpression(decl.init)) {
                        const extracted = extractExportsFromMap(decl.init as t.ObjectExpression);
                        for (const [name, expr] of extracted) exportMap.set(name, expr);
                        break;
                    }
                }
                if (declNode.declarations.length === 1) {
                    stmtsToRemove.add(declNode);
                } else {
                    (declNode as any).declarations = declNode.declarations.filter(
                        (d) => !t.isIdentifier(d.id, { name: mapVarName })
                    );
                }
            }
        }
    }

    // ── Pass 2: filter + require hoisting ────────────────────────────────
    const hoistedImports = new Map<string, string>(); // specifier → importName
    const importNameByNumId = new Map<number, string>(); // numId → importName

    const filteredBody: t.Statement[] = [];
    for (const stmt of body.body) {
        if (stmtsToRemove.has(stmt)) continue;

        // Turbopack-style: `var x = runtime.r(N)` or `var x = runtime.i(N)` → static import
        if (runtimeParam && t.isVariableDeclaration(stmt)) {
            const keptDeclarators: t.VariableDeclarator[] = [];
            for (const decl of stmt.declarations) {
                if (!t.isIdentifier(decl.id) || !decl.init) {
                    keptDeclarators.push(decl);
                    continue;
                }
                const numId = tryExtractTurbopackRequire(decl.init, runtimeParam);
                if (numId === null) {
                    keptDeclarators.push(decl);
                    continue;
                }
                const spec = `./${numId}.js`;
                if (!hoistedImports.has(spec)) {
                    hoistedImports.set(spec, (decl.id as t.Identifier).name);
                    importNameByNumId.set(numId, (decl.id as t.Identifier).name);
                }
                // Declarator removed — becomes a static import
            }
            if (keptDeclarators.length > 0) {
                filteredBody.push(t.variableDeclaration(stmt.kind, keptDeclarators));
            }
            continue;
        }

        // Webpack-style: `var x = requireParam(N)` → static import
        if (isWebpackStyle && requireParam && t.isVariableDeclaration(stmt)) {
            const keptDeclarators: t.VariableDeclarator[] = [];
            for (const decl of stmt.declarations) {
                if (!t.isIdentifier(decl.id) || !decl.init) {
                    keptDeclarators.push(decl);
                    continue;
                }
                const numId = tryExtractWebpackRequire(decl.init, requireParam);
                if (numId === null) {
                    keptDeclarators.push(decl);
                    continue;
                }
                const spec = `./${numId}.js`;
                if (!hoistedImports.has(spec)) {
                    hoistedImports.set(spec, (decl.id as t.Identifier).name);
                    importNameByNumId.set(numId, (decl.id as t.Identifier).name);
                }
                // Declarator removed — becomes a static import
            }
            if (keptDeclarators.length > 0) {
                filteredBody.push(t.variableDeclaration(stmt.kind, keptDeclarators));
            }
            continue;
        }

        filteredBody.push(stmt);
    }

    // ── Pass 3: replace remaining inline require calls ────────────────────
    if (runtimeParam) {
        // Turbopack-style: replace runtime.r(N) / runtime.i(N)
        body.body = filteredBody;
        fnPath.traverse({
            CallExpression(p) {
                const numId = tryExtractTurbopackRequire(p.node, runtimeParam);
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
    } else if (isWebpackStyle && requireParam) {
        // Webpack-style: replace requireParam(N) direct calls
        body.body = filteredBody;
        fnPath.traverse({
            CallExpression(p) {
                const numId = tryExtractWebpackRequire(p.node, requireParam);
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
    } else {
        body.body = filteredBody;
    }

    // ── Build import/export statements ────────────────────────────────────
    const importStmts: t.Statement[] = [];

    // Side-effect imports (r(N) inside a sequence, no binding)
    for (const numId of sideEffectRequireIds) {
        const spec = `./${numId}.js`;
        if (!hoistedImports.has(spec)) {
            importStmts.push(t.importDeclaration([], t.stringLiteral(spec)));
        }
    }

    // Namespace imports
    for (const [spec, name] of hoistedImports) {
        importStmts.push(t.importDeclaration([t.importNamespaceSpecifier(t.identifier(name))], t.stringLiteral(spec)));
    }

    let exportStmts: t.Statement[] = [];

    // webpack CJS re-exports: e.exports = r(N) → export * from './N.js'
    for (const numId of reExportIds) {
        const spec = `./${numId}.js`;
        exportStmts.push(t.exportAllDeclaration(t.stringLiteral(spec)));
    }

    for (const [exportName, returnExpr] of exportMap) {
        exportStmts.push(makeExportStatement(exportName, returnExpr));
    }

    // ── Passes E/F/G/H — cleanup ──────────────────────────────────────────
    let bodyStmts: t.Statement[] = [...body.body];
    bodyStmts = collapseSlicedToArrayDeep(bodyStmts);
    recoverJSX(bodyStmts);
    bodyStmts = removeBabelHelpers(bodyStmts);

    // Also run JSX recovery on export statements — the exported function bodies
    // (e.g. `export default function() {...}` from e.s([]) pattern) contain JSX.
    recoverJSX(exportStmts);
    exportStmts = collapseSlicedToArrayDeep(exportStmts);

    const finalImports = pruneUnusedNamedImports(importStmts, [...bodyStmts, ...exportStmts]);

    return [...finalImports, ...bodyStmts, ...exportStmts];
};

// ---------------------------------------------------------------------------
// Webpack-style module transform (for NNN:(e,t,r)=>{...} chunks in Next.js)
// ---------------------------------------------------------------------------

/**
 * Transforms a webpack-style module (NNN:(module,exports,require)=>{...}) into
 * ECMAScript module statements. Uses the same passes as the turbopack transform
 * since the param order and patterns are identical — only the export registration
 * form differs (require.d vs Object.defineProperty, already handled in Pass 1).
 */
export const transformWebpackModule = (mod: WebpackModuleEntry): t.Statement[] => {
    return transformModule(mod as TurboModuleEntry);
};
