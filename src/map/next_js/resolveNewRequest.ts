import fs from "fs";
import path from "path";
import * as parser from "@babel/parser";
import traverse from "@babel/traverse";
import { Chunks } from "../../utility/interfaces.js";
import { resolveNodeValue, substituteVariablesInString } from "./utils.js";
import { astNodeToJsonString } from "./resolveAxiosHelpers/astNodeToJsonString.js";
import { getThirdArg } from "./resolveAxios.js";
import * as globals from "../../utility/globals.js";
import { printMsg, MSG } from "../../utility/printMsg.js";

const HTTP_METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"];

/**
 * Detect chunks that define an HTTP-request wrapper class. Heuristic:
 * the chunk contains a `class` whose constructor assigns
 *   this.config = { url: ..., method: ..., ... }
 * Returns map of chunkId -> Set of exported binding names that point to such a class.
 */
const findWrapperClasses = (chunks: Chunks): Map<string, Set<string>> => {
    const wrappers = new Map<string, Set<string>>();

    for (const chunk of Object.values(chunks)) {
        if (!chunk.code) continue;
        let ast;
        try {
            ast = parser.parse(chunk.code, {
                sourceType: "unambiguous",
                plugins: ["jsx", "typescript"],
                errorRecovery: true,
            });
        } catch {
            continue;
        }

        const wrapperClassNames = new Set<string>();

        traverse(ast, {
            ClassDeclaration(path) {
                const className = path.node.id?.name;
                if (!className) return;
                if (isWrapperClassBody(path.node.body)) {
                    wrapperClassNames.add(className);
                }
            },
            ClassExpression(path) {
                // Class expressions assigned to a variable: let E = class { ... }
                const parent = path.parent;
                if (parent.type === "VariableDeclarator" && parent.id.type === "Identifier") {
                    if (isWrapperClassBody(path.node.body)) {
                        wrapperClassNames.add(parent.id.name);
                    }
                } else if (parent.type === "AssignmentExpression" && parent.left.type === "Identifier") {
                    if (isWrapperClassBody(path.node.body)) {
                        wrapperClassNames.add(parent.left.name);
                    }
                }
            },
        });

        if (wrapperClassNames.size === 0) continue;

        // Now find which exports point to these classes:
        //   o.d(t, { A: () => E, ... })
        const exportedBindings = new Set<string>();

        traverse(ast, {
            CallExpression(path) {
                const callee = path.node.callee;
                if (
                    callee.type === "MemberExpression" &&
                    callee.property.type === "Identifier" &&
                    callee.property.name === "d" &&
                    path.node.arguments.length >= 2 &&
                    path.node.arguments[1].type === "ObjectExpression"
                ) {
                    for (const prop of path.node.arguments[1].properties) {
                        if (prop.type !== "ObjectProperty" || prop.key.type !== "Identifier") continue;
                        const exportName = prop.key.name;
                        const value = prop.value;
                        // Pattern: A: () => E
                        if (
                            value.type === "ArrowFunctionExpression" &&
                            value.body.type === "Identifier" &&
                            wrapperClassNames.has(value.body.name)
                        ) {
                            exportedBindings.add(exportName);
                        }
                    }
                }
            },
        });

        if (exportedBindings.size > 0) {
            wrappers.set(chunk.id, exportedBindings);
        }
    }

    return wrappers;
};

/**
 * Returns true if a class body looks like an HTTP wrapper:
 * its constructor assigns `this.config = { url: ..., method: ..., ... }`.
 */
const isWrapperClassBody = (body: any): boolean => {
    if (!body || body.type !== "ClassBody") return false;

    for (const member of body.body) {
        if (
            member.type !== "ClassMethod" ||
            member.kind !== "constructor" ||
            !member.body ||
            member.body.type !== "BlockStatement"
        ) {
            continue;
        }

        // Walk all statements/expressions in the constructor and look for
        //   this.config = { url: ..., method: ... }
        let found = false;
        const walkForConfigAssignment = (stmt: any) => {
            if (found) return;
            if (!stmt || typeof stmt !== "object") return;
            if (stmt.type === "AssignmentExpression") {
                const left = stmt.left;
                const right = stmt.right;
                if (
                    left &&
                    left.type === "MemberExpression" &&
                    left.object.type === "ThisExpression" &&
                    left.property.type === "Identifier" &&
                    left.property.name === "config" &&
                    right &&
                    right.type === "ObjectExpression"
                ) {
                    const keys = right.properties
                        .filter((p: any) => p.type === "ObjectProperty")
                        .map((p: any) =>
                            p.key.type === "Identifier"
                                ? p.key.name
                                : p.key.type === "StringLiteral"
                                  ? p.key.value
                                  : null
                        );
                    if (keys.includes("url") && keys.includes("method")) {
                        found = true;
                        return;
                    }
                }
            }
            // Recurse into children
            for (const key of Object.keys(stmt)) {
                if (key === "loc" || key === "start" || key === "end") continue;
                const child = stmt[key];
                if (Array.isArray(child)) {
                    for (const c of child) walkForConfigAssignment(c);
                } else if (child && typeof child === "object" && child.type) {
                    walkForConfigAssignment(child);
                }
            }
        };
        for (const stmt of member.body.body) walkForConfigAssignment(stmt);
        if (found) return true;
    }
    return false;
};

/**
 * Within a chunk, find all `new X(...)` calls. For each, the caller of
 * `findWrapperInstantiations` will decide whether the constructor is a wrapper
 * class. We return the new-expression node plus the matched `X` text.
 */
const findNewExpressionsWithUrl = (ast: any): any[] => {
    const results: any[] = [];
    traverse(ast, {
        NewExpression(path) {
            const args = path.node.arguments;
            if (args.length === 0) return;
            const first = args[0];
            if (first.type !== "ObjectExpression") return;

            // Must have a `url` property (heuristic for HTTP config).
            // Accept both identifier (`url: ...`) and string-literal (`"url": ...`) keys.
            const hasUrl = first.properties.some((p: any) => {
                if (p.type !== "ObjectProperty") return false;
                const keyName =
                    p.key.type === "Identifier" ? p.key.name : p.key.type === "StringLiteral" ? p.key.value : null;
                return keyName === "url";
            });
            if (!hasUrl) return;

            results.push(path);
        },
    });
    return results;
};

/**
 * Resolve which chunk + exported binding a `new X.Y(...)` callee refers to.
 * If the callee is `X.Y`, find `X = require(N)` in the current chunk to get N,
 * then verify N is a wrapper chunk and Y is one of its exported wrapper bindings.
 * Returns the targetChunkId if so, else null.
 */
const resolveCalleeToWrapperChunk = (
    calleeNode: any,
    ast: any,
    thirdArgName: string,
    wrappers: Map<string, Set<string>>
): { chunkId: string; exportName: string } | null => {
    if (!thirdArgName) return null;
    if (calleeNode.type !== "MemberExpression") return null;
    if (calleeNode.object.type !== "Identifier") return null;
    if (calleeNode.property.type !== "Identifier") return null;

    const objName = calleeNode.object.name;
    const exportName = calleeNode.property.name;

    let targetChunkId: string | null = null;
    traverse(ast, {
        VariableDeclarator(p) {
            if (targetChunkId) return;
            const id = p.node.id;
            const init = p.node.init;
            if (id.type !== "Identifier" || id.name !== objName || !init) return;
            if (
                init.type === "CallExpression" &&
                init.callee.type === "Identifier" &&
                init.callee.name === thirdArgName &&
                init.arguments.length > 0
            ) {
                const arg = init.arguments[0];
                if (arg.type === "NumericLiteral") targetChunkId = String(arg.value);
                else if (arg.type === "StringLiteral") targetChunkId = arg.value;
                p.stop();
            }
        },
        AssignmentExpression(p) {
            if (targetChunkId) return;
            const left = p.node.left;
            const right = p.node.right;
            if (left.type !== "Identifier" || left.name !== objName) return;
            if (
                right.type === "CallExpression" &&
                right.callee.type === "Identifier" &&
                right.callee.name === thirdArgName &&
                right.arguments.length > 0
            ) {
                const arg = right.arguments[0];
                if (arg.type === "NumericLiteral") targetChunkId = String(arg.value);
                else if (arg.type === "StringLiteral") targetChunkId = arg.value;
                p.stop();
            }
        },
    });

    if (!targetChunkId) return null;
    const exports = wrappers.get(targetChunkId);
    if (!exports || !exports.has(exportName)) return null;

    return { chunkId: targetChunkId, exportName };
};

/**
 * Extract a known string field (e.g., "method") from the first ObjectExpression
 * argument of a `new` call. Returns the raw value (uppercased for methods) or null.
 */
const extractObjectField = (objExpr: any, fieldName: string): { rawNode: any; stringValue: string | null } | null => {
    if (!objExpr || objExpr.type !== "ObjectExpression") return null;
    for (const prop of objExpr.properties) {
        if (prop.type !== "ObjectProperty") continue;
        const keyName =
            prop.key.type === "Identifier" ? prop.key.name : prop.key.type === "StringLiteral" ? prop.key.value : null;
        if (keyName !== fieldName) continue;
        let val: string | null = null;
        if (prop.value.type === "StringLiteral") val = prop.value.value;
        return { rawNode: prop.value, stringValue: val };
    }
    return null;
};

/**
 * Walks upward from a `new X(...)` path to find the enclosing function
 * declaration/expression. Returns its identifier name if it's named (or
 * assigned to a named variable), else null.
 */
const enclosingFunctionName = (path: any): string | null => {
    let cur = path;
    while (cur) {
        if (cur.isFunctionDeclaration?.()) {
            return cur.node.id?.name || null;
        }
        if (cur.isVariableDeclarator?.()) {
            const init = cur.node.init;
            if (init && (init.type === "ArrowFunctionExpression" || init.type === "FunctionExpression")) {
                return cur.node.id.type === "Identifier" ? cur.node.id.name : null;
            }
        }
        if (cur.isArrowFunctionExpression?.() || cur.isFunctionExpression?.()) {
            const parent = cur.parent;
            if (parent && parent.type === "VariableDeclarator" && parent.id?.type === "Identifier") {
                return parent.id.name;
            }
        }
        cur = cur.parentPath;
    }
    return null;
};

/**
 * Within a chunk's AST, find calls to `factoryName(...)` followed by `.do(<arg>)`
 * (possibly through an intermediate variable). Returns the first such arg AST
 * node found, or null. Handles:
 *   factoryName().do(body)
 *   let x = factoryName(); x.do(body)
 */
const findFactoryDoCallArg = (factoryName: string, ast: any): any | null => {
    let result: any = null;
    // Variables that hold the instance from factoryName()
    const instanceVars = new Set<string>();

    traverse(ast, {
        // let x = factoryName()
        VariableDeclarator(p) {
            const init = p.node.init;
            if (!init) return;
            if (
                init.type === "CallExpression" &&
                init.callee.type === "Identifier" &&
                init.callee.name === factoryName &&
                p.node.id.type === "Identifier"
            ) {
                instanceVars.add(p.node.id.name);
            }
        },
    });

    const DO_METHODS_LOCAL = new Set(["do", "doRawResponse"]);
    traverse(ast, {
        CallExpression(p) {
            if (result) return;
            const callee = p.node.callee;
            // Pattern: <X>.do(<arg>) or <X>.doRawResponse(<arg>)
            if (
                callee.type === "MemberExpression" &&
                callee.property.type === "Identifier" &&
                DO_METHODS_LOCAL.has(callee.property.name) &&
                p.node.arguments.length > 0
            ) {
                // Case A: factoryName().do(arg)
                if (
                    callee.object.type === "CallExpression" &&
                    callee.object.callee.type === "Identifier" &&
                    callee.object.callee.name === factoryName
                ) {
                    result = p.node.arguments[0];
                    p.stop();
                    return;
                }
                // Case B: instance.do(arg) where instance came from factoryName()
                if (callee.object.type === "Identifier" && instanceVars.has(callee.object.name)) {
                    result = p.node.arguments[0];
                    p.stop();
                    return;
                }
            }
        },
    });

    return result;
};

/**
 * For a given factory-export name on a wrapper-instantiation chunk, trace
 * across all chunks that import this chunk, looking for `factory().do(arg)`
 * call patterns. Returns the first `.do()` arg node found.
 */
const traceDoCallAcrossChunks = (
    sourceChunkId: string,
    factoryExportName: string,
    chunks: Chunks
): { argNode: any; chunkCode: string } | null => {
    for (const callerChunk of Object.values(chunks)) {
        if (!callerChunk.imports?.includes(sourceChunkId)) continue;
        if (!callerChunk.code) continue;

        let callerAst;
        try {
            callerAst = parser.parse(callerChunk.code, {
                sourceType: "unambiguous",
                plugins: ["jsx", "typescript"],
                errorRecovery: true,
            });
        } catch {
            continue;
        }

        const thirdArgName = getThirdArg(callerAst);
        if (!thirdArgName) continue;

        // Find which local var binds to require(sourceChunkId)
        let localBinding: string | null = null;
        traverse(callerAst, {
            VariableDeclarator(p) {
                if (localBinding) return;
                const init = p.node.init;
                if (
                    init &&
                    init.type === "CallExpression" &&
                    init.callee.type === "Identifier" &&
                    init.callee.name === thirdArgName &&
                    init.arguments.length > 0 &&
                    p.node.id.type === "Identifier"
                ) {
                    const arg = init.arguments[0];
                    const argVal =
                        arg.type === "NumericLiteral"
                            ? String(arg.value)
                            : arg.type === "StringLiteral"
                              ? arg.value
                              : null;
                    if (argVal === sourceChunkId) {
                        localBinding = p.node.id.name;
                    }
                }
            },
        });
        if (!localBinding) continue;

        // Identify a CallExpression that invokes `localBinding.factoryExportName(...)`,
        // including the `(0, b.factoryName)(...)` SequenceExpression form.
        const isFactoryCall = (n: any): boolean => {
            if (!n || n.type !== "CallExpression") return false;
            const c = n.callee;
            // localBinding.factoryExportName(...)
            if (
                c.type === "MemberExpression" &&
                c.object.type === "Identifier" &&
                c.object.name === localBinding &&
                c.property.type === "Identifier" &&
                c.property.name === factoryExportName
            )
                return true;
            // (0, localBinding.factoryExportName)(...)
            if (c.type === "SequenceExpression" && c.expressions.length === 2) {
                const last = c.expressions[1];
                if (
                    last.type === "MemberExpression" &&
                    last.object.type === "Identifier" &&
                    last.object.name === localBinding &&
                    last.property.type === "Identifier" &&
                    last.property.name === factoryExportName
                )
                    return true;
            }
            return false;
        };

        // Step A: collect instance variable names. Patterns considered:
        //   let x = factory()
        //   let x = useRef(factory())  / useMemo(() => factory())
        //   let x = anyCall(factory())  // assume `.current.do` access for these
        // Returns: Map<varName, {viaCurrent: boolean}>
        const instanceVars = new Map<string, { viaCurrent: boolean }>();

        const findFactoryInExpression = (expr: any): { found: boolean; depth: number } => {
            if (!expr || typeof expr !== "object") return { found: false, depth: 0 };
            if (isFactoryCall(expr)) return { found: true, depth: 0 };
            if (expr.type === "CallExpression" && expr.arguments) {
                for (const a of expr.arguments) {
                    const r = findFactoryInExpression(a);
                    if (r.found) return { found: true, depth: r.depth + 1 };
                }
            }
            if (expr.type === "ArrowFunctionExpression" || expr.type === "FunctionExpression") {
                if (expr.body) {
                    const r = findFactoryInExpression(expr.body);
                    if (r.found) return { found: true, depth: r.depth + 1 };
                }
            }
            if (expr.type === "BlockStatement" && expr.body) {
                for (const s of expr.body) {
                    if (s.type === "ReturnStatement" && s.argument) {
                        const r = findFactoryInExpression(s.argument);
                        if (r.found) return { found: true, depth: r.depth + 1 };
                    }
                }
            }
            return { found: false, depth: 0 };
        };

        traverse(callerAst, {
            VariableDeclarator(p) {
                const init = p.node.init;
                if (!init || p.node.id.type !== "Identifier") return;
                const r = findFactoryInExpression(init);
                if (r.found) {
                    // depth>0 means it's wrapped (e.g., useRef) → access via .current
                    instanceVars.set(p.node.id.name, { viaCurrent: r.depth > 0 });
                }
            },
        });

        // Step B: find `.do(arg)` / `.doRawResponse(arg)` calls referencing an
        // instance var or factory directly.
        let argNode: any = null;
        const DO_METHODS = new Set(["do", "doRawResponse"]);
        traverse(callerAst, {
            CallExpression(p) {
                if (argNode) return;
                const callee = p.node.callee;
                if (
                    callee.type !== "MemberExpression" ||
                    callee.property.type !== "Identifier" ||
                    !DO_METHODS.has(callee.property.name) ||
                    p.node.arguments.length === 0
                )
                    return;

                const recv = callee.object;

                // Pattern 1: factory().do(arg)
                if (isFactoryCall(recv)) {
                    argNode = p.node.arguments[0];
                    p.stop();
                    return;
                }

                // Pattern 2: instance.do(arg)
                if (recv.type === "Identifier") {
                    const info = instanceVars.get(recv.name);
                    if (info && !info.viaCurrent) {
                        argNode = p.node.arguments[0];
                        p.stop();
                        return;
                    }
                }

                // Pattern 3: instance.current.do(arg)
                if (
                    recv.type === "MemberExpression" &&
                    recv.object.type === "Identifier" &&
                    recv.property.type === "Identifier" &&
                    recv.property.name === "current"
                ) {
                    const info = instanceVars.get(recv.object.name);
                    if (info) {
                        argNode = p.node.arguments[0];
                        p.stop();
                        return;
                    }
                }
            },
        });

        if (argNode) {
            return { argNode, chunkCode: callerChunk.code };
        }
    }
    return null;
};

/**
 * Resolves wrapper-class HTTP requests: detects `new X.Y({url, method, ...}, ...)`
 * patterns where X.Y is an exported HTTP-request wrapper class from another
 * webpack chunk, then resolves the URL, method, and body schema.
 */
const resolveNewRequest = async (chunks: Chunks, directory: string) => {
    printMsg(MSG.Header, "[i] Resolving wrapper-class HTTP requests (new X({url, method, ...}))");

    const wrappers = findWrapperClasses(chunks);
    if (wrappers.size === 0) {
        printMsg(MSG.Warn, "    [!] No HTTP-wrapper classes detected");
        return;
    }

    for (const [chunkId, exports] of wrappers.entries()) {
        printMsg(MSG.Run, `    [✓] Wrapper class chunk ${chunkId} exports: ${Array.from(exports).join(", ")}`);
    }

    // Also collect, per wrapper chunk, the set of "factory" export bindings
    // i.e. functions in OTHER chunks that return `new <wrapper>(...)` instances.
    // Built lazily as we scan chunks below.

    for (const chunk of Object.values(chunks)) {
        if (!chunk.code || !chunk.file) continue;

        let ast;
        try {
            ast = parser.parse(chunk.code, {
                sourceType: "unambiguous",
                plugins: ["jsx", "typescript"],
                errorRecovery: true,
            });
        } catch {
            continue;
        }

        const thirdArgName = getThirdArg(ast);
        if (!thirdArgName) continue;

        const newExprPaths = findNewExpressionsWithUrl(ast);
        if (newExprPaths.length === 0) continue;

        const filePath = path.join(directory, chunk.file);
        let fileContent: string;
        try {
            fileContent = fs.readFileSync(filePath, "utf-8");
        } catch {
            fileContent = chunk.code;
        }

        // Per-chunk: build a map of local factory-function names -> the export
        // name (in the wrapper-instance chunk) under which they're exported.
        const factoryExports = new Map<string, string>();
        traverse(ast, {
            CallExpression(p) {
                const callee = p.node.callee;
                if (
                    callee.type === "MemberExpression" &&
                    callee.property.type === "Identifier" &&
                    callee.property.name === "d" &&
                    p.node.arguments.length >= 2 &&
                    p.node.arguments[1].type === "ObjectExpression"
                ) {
                    for (const prop of p.node.arguments[1].properties) {
                        if (
                            prop.type === "ObjectProperty" &&
                            prop.key.type === "Identifier" &&
                            prop.value.type === "ArrowFunctionExpression" &&
                            prop.value.body.type === "Identifier"
                        ) {
                            factoryExports.set(prop.value.body.name, prop.key.name);
                        }
                    }
                }
            },
        });

        for (const newPath of newExprPaths) {
            const calleeNode = newPath.node.callee;
            const target = resolveCalleeToWrapperChunk(calleeNode, ast, thirdArgName, wrappers);
            if (!target) continue;

            const args = newPath.node.arguments;
            const configObj = args[0];
            const optionsObj = args.length > 1 ? args[1] : null;

            // Resolve URL
            const urlField = extractObjectField(configObj, "url");
            if (!urlField) continue;
            const urlSrc = chunk.code.slice(urlField.rawNode.start, urlField.rawNode.end);
            let url = urlField.stringValue;
            if (url === null) {
                url = resolveNodeValue(
                    urlField.rawNode,
                    newPath.scope,
                    urlSrc,
                    "new",
                    chunk.code,
                    chunks,
                    thirdArgName
                );
                if (typeof url === "string" && (url.includes("[var ") || url.includes("[MemberExpression"))) {
                    const substituted = substituteVariablesInString(url, chunk.code, chunks, thirdArgName);
                    if (substituted) url = substituted;
                }
            }

            // Resolve method
            const methodField = extractObjectField(configObj, "method");
            let method = "GET";
            if (methodField) {
                if (methodField.stringValue) {
                    method = methodField.stringValue.toUpperCase();
                } else {
                    const resolved = resolveNodeValue(
                        methodField.rawNode,
                        newPath.scope,
                        "",
                        "new",
                        chunk.code,
                        chunks,
                        thirdArgName
                    );
                    if (typeof resolved === "string" && HTTP_METHODS.includes(resolved.toUpperCase())) {
                        method = resolved.toUpperCase();
                    }
                }
            }

            // Determine dataType (body vs query). The wrapper class defaults to "query"
            // if not specified, so absence ≡ "query".
            let dataType: "body" | "query" = "query";
            if (optionsObj && optionsObj.type === "ObjectExpression") {
                const dt = extractObjectField(optionsObj, "dataType");
                if (dt?.stringValue === "body") dataType = "body";
            }

            // Find enclosing factory function name, then try to trace .do(<arg>)
            // calls from chunks that import this chunk.
            let bodyJson: string = "";
            const factoryName = enclosingFunctionName(newPath);
            if (factoryName) {
                const exportName = factoryExports.get(factoryName);
                if (exportName) {
                    // Also try local in-chunk call: factoryName().do(arg)
                    let argInfo: { argNode: any; chunkCode: string } | null = null;
                    const localArg = findFactoryDoCallArg(factoryName, ast);
                    if (localArg) {
                        argInfo = { argNode: localArg, chunkCode: chunk.code };
                    } else {
                        argInfo = traceDoCallAcrossChunks(chunk.id, exportName, chunks);
                    }
                    if (argInfo) {
                        bodyJson = astNodeToJsonString(argInfo.argNode, argInfo.chunkCode);
                    }
                }
            }

            const lineNo = findLineInFile(fileContent, chunk.code, newPath.node);

            printMsg(MSG.Info, `[+] Found wrapped HTTP request in chunk ${chunk.id} ("${filePath}":${lineNo})`);
            // For dataType="query", attach the resolved arg keys as a query string
            // to the URL so the OpenAPI generator surfaces them as `in: query` params.
            let finalUrl = typeof url === "string" ? url : String(url ?? "");
            if (dataType === "query" && bodyJson) {
                const qs = jsonStringToQueryString(bodyJson);
                if (qs) finalUrl = finalUrl + (finalUrl.includes("?") ? "&" : "?") + qs;
            }

            printMsg(MSG.Run, `    URL: ${finalUrl}`);
            printMsg(MSG.Run, `    Method: ${method}`);
            printMsg(MSG.Info, `    dataType: ${dataType}`);
            if (bodyJson) {
                if (dataType === "query") {
                    printMsg(MSG.Run, `    Query params: ${bodyJson}`);
                } else {
                    printMsg(MSG.Run, `    Body: ${bodyJson}`);
                }
            }

            globals.addOpenapiOutput({
                url: finalUrl,
                method,
                path: finalUrl,
                headers: {},
                body: dataType === "body" ? bodyJson : "",
                chunkId: chunk.id,
                functionFile: filePath,
                functionFileLine: lineNo,
            });
        }
    }
};

/**
 * Convert a JSON-ish string produced by astNodeToJsonString
 * (which renders identifiers as bare strings and member exprs as code text)
 * into a `key1=val1&key2=val2` query string for OpenAPI consumption.
 * Best-effort: any unparseable values are emitted as `{var}` placeholders.
 */
const jsonStringToQueryString = (s: string): string => {
    try {
        // astNodeToJsonString emits valid-ish JSON; try parsing first
        const obj = JSON.parse(s);
        if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return "";
        const parts: string[] = [];
        for (const [k, v] of Object.entries(obj)) {
            const valStr = typeof v === "string" ? v : JSON.stringify(v);
            parts.push(`${encodeURIComponent(k)}={${encodeURIComponent(valStr)}}`);
        }
        return parts.join("&");
    } catch {
        return "";
    }
};

const findLineInFile = (fileContent: string, chunkCode: string, node: any): number => {
    try {
        const snippet = chunkCode.slice(node.start, node.end).split("\n")[0].trim();
        if (!snippet) return -1;
        const probe = snippet.slice(0, Math.min(snippet.length, 40));
        const lines = fileContent.split("\n");
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes(probe)) return i + 1;
        }
    } catch {}
    return -1;
};

export default resolveNewRequest;
