import traverse from "@babel/traverse";
import * as parser from "@babel/parser";
import { Chunks } from "../../../utility/interfaces.js";

/**
 * Detects HTTP headers injected by axios request interceptors so they can be
 * surfaced on every traced call.
 *
 * Apps in this codebase wire global headers via:
 *
 *   axios.interceptors.request.use(X.Z.authHeaderInterceptor());
 *
 * where `authHeaderInterceptor()` returns `async function(e) { ... e.headers.X = "v" ... }`.
 * The interceptor body assigns request headers, so any axios call going through
 * this client implicitly carries those headers — but the tool used to miss them
 * entirely because it only looked at per-call `headers:` options.
 *
 * Algorithm:
 *   1. Scan every chunk for `*.interceptors.request.use(<arg>)` registrations.
 *   2. Resolve `<arg>` to a function expression. Three argument shapes are common:
 *        a. `<member>.<member>()` — a static class method returning a function.
 *        b. `<localFunc>()` — local helper returning a function.
 *        c. an inline function expression.
 *   3. Find static class methods cross-chunk via `findStaticMethodInChunks` and
 *      grab their return expression.
 *   4. Walk the resolved function body and extract every assignment of the form
 *      `<param>.headers.<key> = <literal>` or `<param>.headers["<key>"] = <literal>`.
 *
 * Returns a map of header name → header value collected across every interceptor
 * found in the bundle.
 */
export const collectInterceptorHeaders = (chunks: Chunks): { [key: string]: string } => {
    const headers: { [key: string]: string } = {};

    const astCache = new Map<string, any>();
    const parseAst = (chunkId: string, code: string): any | null => {
        if (astCache.has(chunkId)) return astCache.get(chunkId);
        try {
            const ast = parser.parse(code, {
                sourceType: "unambiguous",
                plugins: ["jsx", "typescript"],
                errorRecovery: true,
            });
            astCache.set(chunkId, ast);
            return ast;
        } catch {
            astCache.set(chunkId, null);
            return null;
        }
    };

    // Pre-build an index of static class methods by name so we can resolve
    // `<X>.<Y>.<methodName>()` calls across chunks. Webpack class methods land
    // as `static methodName() { return function(...){...} }` blocks.
    const staticMethodIndex = new Map<string, Array<{ chunkId: string; node: any; ast: any }>>();

    for (const [chunkId, chunk] of Object.entries(chunks)) {
        const ast = parseAst(chunkId, chunk.code);
        if (!ast) continue;
        traverse(ast, {
            ClassMethod(p) {
                if (!p.node.static) return;
                const key: any = p.node.key;
                const methodName = key.type === "Identifier" ? key.name : null;
                if (!methodName) return;
                const arr = staticMethodIndex.get(methodName) ?? [];
                arr.push({ chunkId, node: p.node, ast });
                staticMethodIndex.set(methodName, arr);
            },
        });
    }

    const extractHeadersFromFunctionBody = (body: any) => {
        if (!body) return;
        const visitNode = (node: any) => {
            if (!node || typeof node !== "object") return;
            if (
                node.type === "AssignmentExpression" &&
                node.operator === "=" &&
                node.left?.type === "MemberExpression" &&
                node.left.object?.type === "MemberExpression" &&
                node.left.object.property?.type === "Identifier" &&
                node.left.object.property.name === "headers"
            ) {
                let key: string | null = null;
                if (!node.left.computed && node.left.property?.type === "Identifier") {
                    key = node.left.property.name;
                } else if (node.left.computed && node.left.property?.type === "StringLiteral") {
                    key = node.left.property.value;
                }
                let value: string | null = null;
                if (node.right?.type === "StringLiteral") {
                    value = node.right.value;
                } else if (node.right?.type === "NumericLiteral") {
                    value = String(node.right.value);
                } else if (node.right?.type === "BooleanLiteral") {
                    value = String(node.right.value);
                } else if (node.right?.type === "BinaryExpression" && node.right.operator === "+") {
                    // e.g. `"Bearer " + o` — capture the literal prefix.
                    if (node.right.left?.type === "StringLiteral") {
                        value = `${node.right.left.value}<token>`;
                    } else if (node.right.right?.type === "StringLiteral") {
                        value = `<value>${node.right.right.value}`;
                    } else {
                        value = "<value>";
                    }
                } else {
                    value = `<${node.right?.type ?? "value"}>`;
                }
                if (key && value !== null) headers[key] = value;
            }
            for (const k of Object.keys(node)) {
                if (k === "loc" || k === "start" || k === "end" || k === "leadingComments" || k === "trailingComments")
                    continue;
                const v = (node as any)[k];
                if (Array.isArray(v)) {
                    for (const item of v) visitNode(item);
                } else if (v && typeof v === "object" && typeof v.type === "string") {
                    visitNode(v);
                }
            }
        };
        visitNode(body);
    };

    // Given a static method node, return the returned function expression (if any).
    const getReturnedFunction = (methodNode: any): any | null => {
        if (!methodNode?.body?.body) return null;
        for (const stmt of methodNode.body.body) {
            if (stmt.type === "ReturnStatement" && stmt.argument) {
                if (stmt.argument.type === "FunctionExpression" || stmt.argument.type === "ArrowFunctionExpression") {
                    return stmt.argument;
                }
                if (stmt.argument.type === "Identifier") {
                    // returns a named function — not handled here.
                    return null;
                }
            }
        }
        return null;
    };

    for (const [chunkId, chunk] of Object.entries(chunks)) {
        const ast = parseAst(chunkId, chunk.code);
        if (!ast) continue;

        traverse(ast, {
            CallExpression(p) {
                const callee: any = p.node.callee;
                // Match `<X>.interceptors.request.use(<arg>)`.
                if (
                    callee.type !== "MemberExpression" ||
                    callee.property?.type !== "Identifier" ||
                    callee.property.name !== "use" ||
                    callee.object?.type !== "MemberExpression" ||
                    callee.object.property?.type !== "Identifier" ||
                    callee.object.property.name !== "request" ||
                    callee.object.object?.type !== "MemberExpression" ||
                    callee.object.object.property?.type !== "Identifier" ||
                    callee.object.object.property.name !== "interceptors"
                ) {
                    return;
                }
                const arg = p.node.arguments[0];
                if (!arg) return;

                let fnBody: any = null;

                if (arg.type === "CallExpression") {
                    const argCallee = arg.callee;
                    if (argCallee.type === "MemberExpression" && argCallee.property?.type === "Identifier") {
                        const methodName = argCallee.property.name;
                        const matches = staticMethodIndex.get(methodName);
                        if (matches) {
                            for (const m of matches) {
                                const returnedFn = getReturnedFunction(m.node);
                                if (returnedFn) {
                                    fnBody = returnedFn.body;
                                    extractHeadersFromFunctionBody(fnBody);
                                }
                            }
                            return;
                        }
                    }
                } else if (arg.type === "FunctionExpression" || arg.type === "ArrowFunctionExpression") {
                    fnBody = arg.body;
                }

                if (fnBody) extractHeadersFromFunctionBody(fnBody);
            },
        });
    }

    return headers;
};
