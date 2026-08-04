import { resolveNodeValue, substituteVariablesInString } from "./utils.js";
import parser from "@babel/parser";
import _traverse from "@babel/traverse";
import fs from "fs";
import path from "path";
import { Chunks } from "../../utility/interfaces.js";
import { getThirdArg } from "./resolveAxios.js";
import { Node } from "@babel/types";
const traverse = (_traverse.default ?? _traverse) as typeof _traverse.default;
import * as globals from "../../utility/globals.js";
import { printMsg, MSG } from "../../utility/printMsg.js";

/**
 * Finds the function name that wraps a fetch call.
 */
const getFunctionNameForFetchCall = (fetchCallPath: any): string | null => {
    let currentPath = fetchCallPath;

    // Traverse up the AST to find the containing function
    while (currentPath) {
        if (currentPath.isFunctionDeclaration()) {
            return currentPath.node.id?.name || null;
        }
        if (currentPath.isVariableDeclarator()) {
            const init = currentPath.node.init;
            if (init && (init.type === "FunctionExpression" || init.type === "ArrowFunctionExpression")) {
                return currentPath.node.id.type === "Identifier" ? currentPath.node.id.name : null;
            }
        }
        if (currentPath.isFunctionExpression() || currentPath.isArrowFunctionExpression()) {
            // Check if parent is a variable declarator
            const parent = currentPath.parent;
            if (parent.type === "VariableDeclarator" && parent.id.type === "Identifier") {
                return parent.id.name;
            }
        }
        currentPath = currentPath.parentPath;
    }
    return null;
};

/**
 * Finds which export in a chunk returns a given function name.
 */
const findExportForFunction = (chunkCode: string, functionName: string, exportNames: string[]): string | null => {
    if (!exportNames || exportNames.length === 0) return null;

    try {
        const ast = parser.parse(chunkCode, {
            sourceType: "module",
            plugins: ["jsx", "typescript"],
            errorRecovery: true,
        });

        let foundExport: string | null = null;

        traverse(ast, {
            // Pattern 1: t.d(r, { $C: () => i, ... })
            CallExpression(path) {
                const callee = path.node.callee;
                if (
                    callee.type === "MemberExpression" &&
                    callee.property.type === "Identifier" &&
                    callee.property.name === "d" &&
                    path.node.arguments.length >= 2
                ) {
                    const secondArg = path.node.arguments[1];
                    if (secondArg.type === "ObjectExpression") {
                        for (const prop of secondArg.properties) {
                            if (
                                prop.type === "ObjectProperty" &&
                                prop.key.type === "Identifier" &&
                                exportNames.includes(prop.key.name)
                            ) {
                                const value = prop.value;

                                // Pattern: exportName: () => functionName
                                if (
                                    value.type === "ArrowFunctionExpression" &&
                                    value.body.type === "Identifier" &&
                                    value.body.name === functionName
                                ) {
                                    foundExport = prop.key.name;
                                    path.stop();
                                    return;
                                }
                            }
                        }
                    }
                }
            },
            // Pattern 2: { exportName: () => functionName } (direct object)
            ObjectProperty(path) {
                if (path.node.key.type === "Identifier" && exportNames.includes(path.node.key.name)) {
                    const value = path.node.value;

                    // Pattern: exportName: () => functionName
                    if (
                        value.type === "ArrowFunctionExpression" &&
                        value.body.type === "Identifier" &&
                        value.body.name === functionName
                    ) {
                        foundExport = path.node.key.name;
                        path.stop();
                    }
                    // Pattern: exportName: function() { return functionName }
                    else if (value.type === "FunctionExpression" && value.body.type === "BlockStatement") {
                        const returnStmt = value.body.body.find((stmt: any) => stmt.type === "ReturnStatement");
                        if (
                            (returnStmt as any)?.argument?.type === "Identifier" &&
                            (returnStmt as any).argument.name === functionName
                        ) {
                            foundExport = path.node.key.name;
                            path.stop();
                        }
                    }
                }
            },
        });

        return foundExport;
    } catch (e) {
        return null;
    }
};

/**
 * Traces fetch function calls across chunks to resolve body parameters.
 */
const traceFetchFunctionCalls = (
    fetchChunkId: string,
    exportName: string,
    functionName: string,
    chunks: Chunks,
    directory: string
): any => {
    // Find chunks that import the fetch chunk
    for (const [callerChunkId, callerChunk] of Object.entries(chunks)) {
        if (!callerChunk.imports || !callerChunk.file) continue;

        // Check if this chunk imports our fetch chunk
        if (!callerChunk.imports.includes(fetchChunkId)) continue;

        printMsg(
            MSG.Header,
            `    [\u2192] Chunk ${callerChunkId} imports fetch chunk ${fetchChunkId}, tracing calls...`
        );

        // Load the caller chunk code
        const callerFilePath = path.join(directory, callerChunk.file);
        let callerCode: string;
        try {
            callerCode = fs.readFileSync(callerFilePath, "utf-8");
        } catch (e) {
            continue;
        }

        // Parse caller chunk
        let callerAst: Node;
        try {
            callerAst = parser.parse(callerCode, {
                sourceType: "module",
                plugins: ["jsx", "typescript"],
                errorRecovery: true,
            });
        } catch (e) {
            continue;
        }

        // Get the third arg (webpack require function name)
        const thirdArgName = getThirdArg(callerAst);
        if (!thirdArgName) continue;

        // Find calls to the exported function
        const callArguments: any[] = [];

        traverse(callerAst, {
            CallExpression(path) {
                const callee = path.node.callee;

                // Pattern 1: (0, varName.exportName)(...)
                if (callee.type === "SequenceExpression" && callee.expressions.length === 2) {
                    const secondExpr = callee.expressions[1];
                    if (
                        secondExpr.type === "MemberExpression" &&
                        secondExpr.property.type === "Identifier" &&
                        secondExpr.property.name === exportName
                    ) {
                        callArguments.push(...path.node.arguments);
                    }
                }
                // Pattern 2: varName.exportName(...)
                else if (
                    callee.type === "MemberExpression" &&
                    callee.property.type === "Identifier" &&
                    callee.property.name === exportName
                ) {
                    callArguments.push(...path.node.arguments);
                }
                // Pattern 3: Direct call after import resolution
                else if (callee.type === "Identifier") {
                    // Check if this identifier is bound to our exported function
                    const binding = path.scope.getBinding(callee.name);
                    if (binding && binding.path.isVariableDeclarator()) {
                        const init = binding.path.node.init;
                        if (
                            init &&
                            init.type === "MemberExpression" &&
                            init.property.type === "Identifier" &&
                            init.property.name === exportName
                        ) {
                            callArguments.push(...path.node.arguments);
                        }
                    }
                }
            },
        });

        if (callArguments.length > 0) {
            printMsg(
                MSG.Run,
                `    [\u2713] Found ${callArguments.length} call(s) to ${exportName} in chunk ${callerChunkId}`
            );
            // Return the first argument (usually the body object)
            return callArguments[0];
        }
    }

    return null;
};

/**
 * Resolves fetch instances in the given chunks.
 * @param {Chunks} chunks - A dictionary of chunk names to chunk objects.
 * @param {string} directory - The directory of the chunk file.
 */
/**
 * Finds all call-site first-arguments for a given function name within a
 * single module's code. Used to resolve URL placeholders when the fetch
 * wrapper is a non-exported (module-internal) function.
 */
const traceInternalFunctionCalls = (functionName: string, moduleCode: string): any[] => {
    try {
        const ast = parser.parse(moduleCode, {
            sourceType: "module",
            plugins: ["jsx", "typescript"],
            errorRecovery: true,
        });
        const firstArgs: any[] = [];
        traverse(ast, {
            CallExpression(path) {
                const callee = path.node.callee;
                if (callee.type === "Identifier" && callee.name === functionName && path.node.arguments.length > 0) {
                    firstArgs.push(path.node.arguments[0]);
                }
            },
        });
        return firstArgs;
    } catch {
        return [];
    }
};

/**
 * Returns true when the chunk's code looks like a Next.js framework-internal
 * module (RSC router, Server Actions reducer, etc.) that should not be
 * reported as user-defined API endpoints.
 */
const isNextJsFrameworkChunk = (code: string): boolean => {
    // RSC navigation / router internals
    if (code.includes("NEXT_RSC_UNION_QUERY") || code.includes("setCacheBustingSearchParam")) {
        return true;
    }
    // Server Actions reducer exported by the Next.js runtime
    if (code.includes('"serverActionReducer"') || code.includes("serverActionReducer:")) {
        return true;
    }
    // CSS stylesheet lazy-loader — fetch(r) is a stylesheet URL, not an API endpoint
    if (code.includes("markAssetError") || code.includes("fetchStyleSheet")) {
        return true;
    }
    // Next.js data fetcher internals — x-nextjs-data header is injected by the framework
    if (code.includes('"x-nextjs-data"') || code.includes("'x-nextjs-data'")) {
        return true;
    }
    return false;
};

const resolveFetch = async (chunks: Chunks, directory: string) => {
    printMsg(MSG.Header, "[i] Resolving fetch instances");

    for (const chunk of Object.values(chunks)) {
        if (!chunk.containsFetch || !chunk.file) {
            continue;
        }

        // Skip Next.js framework-internal chunks to avoid noise
        if (isNextJsFrameworkChunk(chunk.code || "")) {
            printMsg(MSG.Info, `    [i] Skipping Next.js framework chunk ${chunk.id}`);
            continue;
        }

        // get the path of the file in which chunk is there
        const filePath = path.join(directory, chunk.file);
        let fileContent: string;

        // try to read the file
        try {
            fileContent = fs.readFileSync(filePath, "utf-8");
        } catch (error) {
            printMsg(MSG.Err, `[!] Could not read file: ${filePath}`);
            continue;
        }

        // try to parse the file
        let fileAst;
        try {
            fileAst = parser.parse(fileContent, {
                sourceType: "module",
                plugins: ["jsx", "typescript"],
                errorRecovery: true,
            });
        } catch (err) {
            printMsg(MSG.Err, `[!] Failed to parse file: ${filePath}. Error: ${err.message}`);
            continue;
        }

        const fetchAliases = new Set();

        // Pass 1: Find fetch aliases on the full file AST
        traverse(fileAst, {
            VariableDeclarator(path) {
                if (path.node.id.type === "Identifier" && path.node.init) {
                    if (path.node.init.type === "Identifier" && path.node.init.name === "fetch") {
                        const binding = path.scope.getBinding(path.node.id.name);
                        if (binding) fetchAliases.add(binding);
                    }
                }
            },
        });

        // Get the third arg (webpack require function name) for this chunk
        const thirdArgName = getThirdArg(fileAst);

        // define some arguments to be finally printed
        let callUrl: string;
        let callMethod: string;
        let callHeaders: { [key: string]: string };
        let callBody: string;
        let chunkId: string;
        let functionFileLine: number;

        // Pass 2: Find and resolve fetch calls on the full file AST
        traverse(fileAst, {
            CallExpression(path) {
                let isFetchCall = false;
                const calleeName = (path.node.callee as any).name;

                if (calleeName === "fetch") {
                    isFetchCall = true;
                } else {
                    const binding = path.scope.getBinding(calleeName);
                    if (binding && fetchAliases.has(binding)) {
                        isFetchCall = true;
                    }
                }

                if (isFetchCall) {
                    printMsg(
                        MSG.Info,
                        `[+] Found fetch call in chunk ${chunk.id} ("${filePath}":${path.node.loc.start.line})`
                    );
                    functionFileLine = path.node.loc.start.line;
                    const args = path.node.arguments;
                    if (args.length > 0) {
                        // extract the whole code from the main file just in case the resolution fails
                        const argText = fileContent.slice(args[0].start, args[0].end).replace(/\n\s*/g, "");

                        let url = resolveNodeValue(
                            args[0],
                            path.scope,
                            argText,
                            "fetch",
                            fileContent,
                            chunks,
                            thirdArgName
                        );

                        // Substitute any [var X] or [MemberExpression -> X] placeholders with actual values from the chunk.
                        // Use chunk.code (module-scoped) rather than the entire fileContent to prevent
                        // cross-module variable name collisions from polluting the resolved value.
                        if (typeof url === "string" && (url.includes("[var ") || url.includes("[MemberExpression"))) {
                            const substitutedUrl = substituteVariablesInString(url, chunk.code, chunks, thirdArgName);
                            if (substitutedUrl !== url) {
                                printMsg(MSG.Header, `    [i] Resolved variables in URL: ${url} -> ${substitutedUrl}`);
                                url = substitutedUrl;
                            }
                        }

                        // If the URL still has unresolved [var X] placeholders, try to
                        // resolve them by tracing internal (non-exported) callers within
                        // the same module. This handles patterns like:
                        //   function J(e, t) { fetch("".concat(t.basePath, "/").concat(e)) }
                        //   J("session", Y)  →  resolved e = "session"
                        if (typeof url === "string" && url.includes("[var ")) {
                            const wrapperName = getFunctionNameForFetchCall(path);
                            if (wrapperName) {
                                const internalCallArgs = traceInternalFunctionCalls(wrapperName, chunk.code);
                                if (internalCallArgs.length > 0) {
                                    // Use the first resolved arg as a representative URL component
                                    const firstArgResolved = resolveNodeValue(
                                        internalCallArgs[0],
                                        path.scope,
                                        "",
                                        "fetch",
                                        fileContent,
                                        chunks,
                                        thirdArgName
                                    );
                                    if (
                                        firstArgResolved &&
                                        typeof firstArgResolved === "string" &&
                                        !firstArgResolved.startsWith("[")
                                    ) {
                                        // Replace [var X] with the resolved caller argument
                                        const varMatch = url.match(/\[var ([^\]]+)\]/);
                                        if (varMatch) {
                                            url = url.replace(varMatch[0], firstArgResolved);
                                            printMsg(MSG.Header, `    [i] Resolved URL from internal caller: ${url}`);
                                        }
                                    }
                                }
                            }
                        }

                        // Resolve [param:X] in the URL by tracing callers of the wrapping function.
                        // This handles patterns like: function wrapFetch(r) { fetch(r, opts) }
                        // where the entire URL is passed in as a parameter from the callsite.
                        if (typeof url === "string" && url.includes("[param:")) {
                            const wrapperName = getFunctionNameForFetchCall(path);
                            if (wrapperName) {
                                // Try callers within the same module first (no export needed)
                                const internalCallArgs = traceInternalFunctionCalls(wrapperName, chunk.code);
                                if (internalCallArgs.length > 0) {
                                    const firstArgResolved = resolveNodeValue(
                                        internalCallArgs[0],
                                        path.scope,
                                        "",
                                        "fetch",
                                        fileContent,
                                        chunks,
                                        thirdArgName
                                    );
                                    if (
                                        firstArgResolved &&
                                        typeof firstArgResolved === "string" &&
                                        !firstArgResolved.startsWith("[")
                                    ) {
                                        url = url.replace(/\[param:[^\]]+\]/g, firstArgResolved);
                                        printMsg(
                                            MSG.Header,
                                            `    [i] Resolved [param] URL from internal caller: ${url}`
                                        );
                                    }
                                }
                                // Fall back to cross-chunk exported callers
                                if (url.includes("[param:") && chunk.exports && chunk.exports.length > 0) {
                                    const exportName = findExportForFunction(fileContent, wrapperName, chunk.exports);
                                    if (exportName) {
                                        const actualCallArg = traceFetchFunctionCalls(
                                            chunk.id,
                                            exportName,
                                            wrapperName,
                                            chunks,
                                            directory
                                        );
                                        if (actualCallArg) {
                                            const callerUrl = resolveNodeValue(
                                                actualCallArg,
                                                path.scope,
                                                "",
                                                "fetch",
                                                fileContent,
                                                chunks,
                                                thirdArgName
                                            );
                                            if (
                                                callerUrl &&
                                                typeof callerUrl === "string" &&
                                                !callerUrl.startsWith("[unresolved") &&
                                                !callerUrl.startsWith("[error") &&
                                                (callerUrl.includes("/") || callerUrl.includes("://"))
                                            ) {
                                                printMsg(
                                                    MSG.Header,
                                                    `    [i] Resolved [param] URL from exported caller: ${callerUrl}`
                                                );
                                                url = callerUrl;
                                            }
                                        }
                                    }
                                }
                            }
                        }

                        callUrl = url;
                        printMsg(MSG.Run, `    URL: ${url}`);

                        if (args.length > 1) {
                            let options = resolveNodeValue(
                                args[1],
                                path.scope,
                                "",
                                "fetch",
                                fileContent,
                                chunks,
                                thirdArgName
                            );

                            // Try to trace fetch function exports for better body resolution
                            const functionName = getFunctionNameForFetchCall(path);
                            if (functionName && chunk.exports && chunk.exports.length > 0) {
                                printMsg(
                                    MSG.Header,
                                    `    [i] Fetch is wrapped in function '${functionName}', checking for exports...`
                                );

                                const exportName = findExportForFunction(fileContent, functionName, chunk.exports);
                                if (exportName) {
                                    printMsg(
                                        MSG.Header,
                                        `    [i] Function '${functionName}' exported as '${exportName}', tracing calls...`
                                    );

                                    const actualCallArg = traceFetchFunctionCalls(
                                        chunk.id,
                                        exportName,
                                        functionName,
                                        chunks,
                                        directory
                                    );

                                    if (actualCallArg) {
                                        // Resolve the actual call argument to get the real body
                                        const resolvedArg = resolveNodeValue(actualCallArg, path.scope, "", "fetch");
                                        if (resolvedArg && typeof resolvedArg === "object") {
                                            printMsg(
                                                MSG.Run,
                                                `    [✓] Resolved actual body from caller: ${JSON.stringify(resolvedArg)}`
                                            );
                                            // Update options.body with the resolved value
                                            if (typeof options === "object" && options !== null) {
                                                options = { ...options, body: resolvedArg };
                                            }
                                        }
                                    }
                                }
                            }

                            if (typeof options === "object" && options !== null) {
                                // Substitute variables in headers
                                if (options.headers && typeof options.headers === "object") {
                                    const resolvedHeaders: { [key: string]: string } = {};
                                    for (const [key, value] of Object.entries(options.headers)) {
                                        const resolvedKey =
                                            typeof key === "string"
                                                ? substituteVariablesInString(key, fileContent, chunks, thirdArgName)
                                                : String(key);
                                        const resolvedValue =
                                            typeof value === "string"
                                                ? substituteVariablesInString(value, fileContent, chunks, thirdArgName)
                                                : String(value);
                                        resolvedHeaders[resolvedKey] = resolvedValue;
                                    }
                                    options.headers = resolvedHeaders;
                                }

                                // Substitute variables in body if it's an object with string values
                                if (options.body && typeof options.body === "object") {
                                    const resolvedBody: any = {};
                                    for (const [key, value] of Object.entries(options.body)) {
                                        const resolvedValue =
                                            typeof value === "string"
                                                ? substituteVariablesInString(value, fileContent, chunks, thirdArgName)
                                                : value;
                                        resolvedBody[key] = resolvedValue;
                                    }
                                    options.body = resolvedBody;
                                }

                                printMsg(MSG.Run, `    Method: ${options.method || "UNKNOWN"}`);
                                callMethod = options.method || "UNKNOWN";
                                if (options.headers)
                                    printMsg(MSG.Run, `    Headers: ${JSON.stringify(options.headers)}`);
                                if (options.body) printMsg(MSG.Run, `    Body: ${JSON.stringify(options.body)}`);
                                callHeaders =
                                    typeof options.headers === "object" && options.headers !== null
                                        ? options.headers
                                        : {};
                                callBody =
                                    typeof options.body === "object"
                                        ? JSON.stringify(options.body)
                                        : options.body || "";
                            } else {
                                printMsg(MSG.Run, `    Options: ${options}`);
                            }

                            globals.addOpenapiOutput({
                                url: callUrl || "",
                                method: callMethod || "",
                                path: callUrl || "",
                                headers: callHeaders || {},
                                body: callBody || "",
                                chunkId: chunk.id,
                                functionFile: filePath,
                                functionFileLine: functionFileLine,
                            });
                        } else {
                            // Single-argument fetch(url) — implicit GET request.
                            // Try to resolve the URL from callers when the direct resolution
                            // left an unresolved function-parameter placeholder.
                            let resolvedUrl = callUrl || "";

                            if (
                                resolvedUrl.startsWith("[unresolved:") ||
                                resolvedUrl === "" ||
                                resolvedUrl.includes("[param:")
                            ) {
                                const functionName = getFunctionNameForFetchCall(path);
                                if (functionName && chunk.exports && chunk.exports.length > 0) {
                                    const exportName = findExportForFunction(fileContent, functionName, chunk.exports);
                                    if (exportName) {
                                        printMsg(
                                            MSG.Header,
                                            `    [i] Fetch is wrapped in function '${functionName}', checking for exports...`
                                        );
                                        const actualCallArg = traceFetchFunctionCalls(
                                            chunk.id,
                                            exportName,
                                            functionName,
                                            chunks,
                                            directory
                                        );
                                        if (actualCallArg) {
                                            const callerUrl = resolveNodeValue(
                                                actualCallArg,
                                                path.scope,
                                                "",
                                                "fetch",
                                                fileContent,
                                                chunks,
                                                thirdArgName
                                            );
                                            if (
                                                callerUrl &&
                                                typeof callerUrl === "string" &&
                                                !callerUrl.startsWith("[unresolved") &&
                                                !callerUrl.startsWith("[error") &&
                                                (callerUrl.includes("/") || callerUrl.includes("://"))
                                            ) {
                                                printMsg(MSG.Header, `    [i] Resolved URL from caller: ${callerUrl}`);
                                                resolvedUrl = callerUrl;
                                            }
                                        }
                                    }
                                }
                            }

                            printMsg(MSG.Run, `    Method: GET`);
                            globals.addOpenapiOutput({
                                url: resolvedUrl,
                                method: "GET",
                                path: resolvedUrl,
                                headers: {},
                                body: "",
                                chunkId: chunk.id,
                                functionFile: filePath,
                                functionFileLine: functionFileLine,
                            });
                        }
                    }
                }
            },
        });
    }
};

export default resolveFetch;
