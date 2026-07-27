import { Chunks } from "../../../utility/interfaces.js";
import _traverse from "@babel/traverse";
import * as fs from "fs";
import parser from "@babel/parser";
import { astNodeToJsonString } from "./astNodeToJsonString.js";
import * as globals from "../../../utility/globals.js";
import { getThirdArg } from "../resolveAxios.js";
import { resolveNodeValue } from "../utils.js";
import { printMsg, MSG } from "../../../utility/printMsg.js";

const traverse = (_traverse.default ?? _traverse) as typeof _traverse.default;

interface AxiosInstanceInfo {
    varName: string;
    chunkId: string;
    exportName?: string;
}

/**
 * Recursively trace axios instance exports across chunks
 *
 * @param {string} sourceChunkId - The chunk ID where the axios instance was created
 * @param {string} axiosVarName - The variable name holding the axios instance
 * @param {Chunks} chunks - Dictionary of all chunks
 * @param {string} directory - Directory containing chunk files
 * @param {Set<string>} visited - Set of visited chunks to prevent infinite recursion
 */
export const traceAxiosInstanceExports = (
    sourceChunkId: string,
    axiosVarName: string,
    chunks: Chunks,
    directory: string,
    visited: Set<string> = new Set()
): void => {
    // Prevent infinite recursion
    if (visited.has(sourceChunkId)) {
        return;
    }
    visited.add(sourceChunkId);

    const sourceChunk = chunks[sourceChunkId];
    if (!sourceChunk) {
        return;
    }

    // Step 1: Find if the axios instance is exported from this chunk
    const exportName = findAxiosInstanceExport(sourceChunkId, axiosVarName, chunks);

    if (!exportName) {
        printMsg(
            MSG.Warn,
            `    [!] Axios instance '${axiosVarName}' in chunk ${sourceChunkId} is not exported`
        );
        return;
    }

    printMsg(
        MSG.Info,
        `    [→] Axios instance '${axiosVarName}' exported as '${exportName}' from chunk ${sourceChunkId}`
    );

    // Step 2: Find all chunks that import this chunk
    const importingChunks = findImportingChunks(sourceChunkId, chunks);

    if (importingChunks.length === 0) {
        printMsg(
            MSG.Warn,
            `    [!] No chunks import the axios instance '${exportName}' from chunk ${sourceChunkId}`
        );
        return;
    }

    printMsg(
        MSG.Info,
        `    [→] Found ${importingChunks.length} chunk(s) importing axios instance '${exportName}'`
    );

    // Step 3: Process each importing chunk
    for (const importingChunkId of importingChunks) {
        processImportingChunk(importingChunkId, sourceChunkId, exportName, chunks, directory, visited);
    }
};

/**
 * Find if an axios instance variable is exported from a chunk
 */
const findAxiosInstanceExport = (chunkId: string, axiosVarName: string, chunks: Chunks): string | null => {
    const chunk = chunks[chunkId];
    if (!chunk || !chunk.exports || chunk.exports.length === 0) {
        return null;
    }

    const chunkCode = chunk.code;
    let ast;
    try {
        ast = parser.parse(chunkCode, {
            sourceType: "unambiguous",
            plugins: ["jsx", "typescript"],
            errorRecovery: true,
        });
    } catch {
        return null;
    }

    let foundExportName: string | null = null;

    // Look for export pattern: n.d(t, { ExportName: function() { return axiosVarName } })
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
                const exportsObj = path.node.arguments[1];

                for (const prop of exportsObj.properties) {
                    if (
                        prop.type === "ObjectProperty" &&
                        (prop.value.type === "FunctionExpression" || prop.value.type === "ArrowFunctionExpression")
                    ) {
                        let exportName = "";
                        if (prop.key.type === "Identifier") {
                            exportName = prop.key.name;
                        } else if (prop.key.type === "StringLiteral") {
                            exportName = prop.key.value;
                        }

                        // Check if this export returns our axios variable
                        if (prop.value.body && prop.value.body.type === "BlockStatement") {
                            for (const stmt of prop.value.body.body) {
                                if (
                                    stmt.type === "ReturnStatement" &&
                                    stmt.argument &&
                                    stmt.argument.type === "Identifier" &&
                                    stmt.argument.name === axiosVarName
                                ) {
                                    foundExportName = exportName;
                                    return;
                                }
                            }
                        } else if (
                            prop.value.body &&
                            prop.value.body.type === "Identifier" &&
                            prop.value.body.name === axiosVarName
                        ) {
                            foundExportName = exportName;
                            return;
                        }
                    }
                }
            }
        },
    });

    return foundExportName;
};

/**
 * Find all chunks that import a specific chunk
 */
const findImportingChunks = (sourceChunkId: string, chunks: Chunks): string[] => {
    const importingChunks: string[] = [];

    for (const [chunkId, chunk] of Object.entries(chunks)) {
        if (chunk.imports && chunk.imports.includes(sourceChunkId)) {
            importingChunks.push(chunkId);
        }
    }

    return importingChunks;
};

/**
 * Process a chunk that imports an axios instance
 */
const processImportingChunk = (
    importingChunkId: string,
    sourceChunkId: string,
    exportName: string,
    chunks: Chunks,
    directory: string,
    visited: Set<string>
): void => {
    const importingChunk = chunks[importingChunkId];
    if (!importingChunk) {
        return;
    }

    const chunkCode = importingChunk.code;
    let ast;
    try {
        ast = parser.parse(chunkCode, {
            sourceType: "unambiguous",
            plugins: ["jsx", "typescript"],
            errorRecovery: true,
        });
    } catch {
        return;
    }

    // Get the third argument (import function)
    const thirdArg = getThirdArg(ast);
    if (!thirdArg) {
        printMsg(MSG.Warn, `    [!] Could not find third argument in chunk ${importingChunkId}`);
        return;
    }

    // Find the variable that imports the axios instance
    const importVarName = findImportVariable(ast, thirdArg, sourceChunkId);
    if (!importVarName) {
        printMsg(
            MSG.Warn,
            `    [!] Could not find import variable for chunk ${sourceChunkId} in chunk ${importingChunkId}`
        );
        return;
    }

    printMsg(
        MSG.Info,
        `    [→] In chunk ${importingChunkId}, axios instance imported as '${importVarName}.${exportName}'`
    );

    // Check if this chunk uses or re-exports the axios instance
    const isReexported = checkIfReexported(ast, importVarName, exportName, chunks, importingChunkId);

    if (isReexported.reexported) {
        printMsg(
            MSG.Info,
            `    [↻] Axios instance re-exported from chunk ${importingChunkId}, tracing further...`
        );
        // Recursively trace the re-export
        traceAxiosInstanceExports(importingChunkId, isReexported.localVarName!, chunks, directory, visited);
    } else {
        // This chunk uses the axios instance, extract API calls
        printMsg(
            MSG.Run,
            `    [✓] Chunk ${importingChunkId} uses the axios instance, extracting API calls...`
        );
        extractApiCalls(ast, chunkCode, importVarName, exportName, importingChunkId, chunks, directory, thirdArg);
    }
};

/**
 * Find the variable that imports the source chunk
 */
const findImportVariable = (ast: any, thirdArg: string, sourceChunkId: string): string | null => {
    let importVar: string | null = null;

    traverse(ast, {
        VariableDeclarator(path) {
            if (
                path.node.init &&
                path.node.init.type === "CallExpression" &&
                path.node.init.callee.type === "Identifier" &&
                path.node.init.callee.name === thirdArg &&
                path.node.init.arguments.length > 0 &&
                path.node.id.type === "Identifier"
            ) {
                const arg = path.node.init.arguments[0];
                if (
                    (arg.type === "NumericLiteral" && arg.value.toString() === sourceChunkId) ||
                    (arg.type === "StringLiteral" && arg.value === sourceChunkId)
                ) {
                    importVar = path.node.id.name;
                    path.stop();
                }
            }
        },
    });

    return importVar;
};

/**
 * Check if the imported axios instance is re-exported
 */
const checkIfReexported = (
    ast: any,
    importVarName: string,
    exportName: string,
    chunks: Chunks,
    chunkId: string
): { reexported: boolean; localVarName?: string } => {
    const chunk = chunks[chunkId];
    if (!chunk || !chunk.exports || chunk.exports.length === 0) {
        return { reexported: false };
    }

    // First, check if there's a local assignment: localVar = importVar.exportName(...)
    let localVarName: string | null = null;
    let foundPattern = false;

    traverse(ast, {
        AssignmentExpression(path) {
            // Check for: p = ((t) => { ... i.C(...) ... })
            if (
                path.node.left.type === "Identifier" &&
                (path.node.right.type === "ArrowFunctionExpression" ||
                    path.node.right.type === "FunctionExpression" ||
                    path.node.right.type === "CallExpression")
            ) {
                // Check if the function body contains a call to importVar.exportName
                const containsAxiosCall = checkNodeForAxiosCall(path.node.right, importVarName, exportName);

                if (containsAxiosCall) {
                    localVarName = path.node.left.name;
                    foundPattern = true;
                    path.stop();
                }
            }
        },
        VariableDeclarator(path) {
            // Check for: const p = ((t) => { ... i.C(...) ... })
            if (
                path.node.id.type === "Identifier" &&
                path.node.init &&
                (path.node.init.type === "ArrowFunctionExpression" ||
                    path.node.init.type === "FunctionExpression" ||
                    path.node.init.type === "CallExpression")
            ) {
                const containsAxiosCall = checkNodeForAxiosCall(path.node.init, importVarName, exportName);

                if (containsAxiosCall) {
                    localVarName = path.node.id.name;
                    foundPattern = true;
                    path.stop();
                }
            }
        },
    });

    if (foundPattern && localVarName) {
        // Check if this local variable is exported
        const isExported = chunk.exports.some((exp) => {
            // We need to check if the export returns localVarName
            return checkIfVariableIsExported(ast, exp, localVarName);
        });

        if (isExported) {
            return { reexported: true, localVarName };
        }
    }

    return { reexported: false };
};

/**
 * Check if a node contains a call to the axios instance (recursive AST inspection)
 */
const checkNodeForAxiosCall = (node: any, importVarName: string, exportName: string): boolean => {
    if (!node) return false;

    // Check if this node is a call expression to our axios instance
    if (node.type === "CallExpression") {
        const callee = node.callee;

        // Check for: importVar.exportName(...)
        if (
            callee.type === "MemberExpression" &&
            callee.object.type === "Identifier" &&
            callee.object.name === importVarName &&
            callee.property.type === "Identifier" &&
            callee.property.name === exportName
        ) {
            return true;
        }

        // Check for: (0, importVar.exportName)(...)
        if (
            callee.type === "SequenceExpression" &&
            callee.expressions.length === 2 &&
            callee.expressions[0].type === "NumericLiteral" &&
            callee.expressions[0].value === 0 &&
            callee.expressions[1].type === "MemberExpression" &&
            callee.expressions[1].object.type === "Identifier" &&
            callee.expressions[1].object.name === importVarName &&
            callee.expressions[1].property.type === "Identifier" &&
            callee.expressions[1].property.name === exportName
        ) {
            return true;
        }
    }

    // Recursively check common node structures
    if (node.body) {
        if (Array.isArray(node.body)) {
            for (const stmt of node.body) {
                if (checkNodeForAxiosCall(stmt, importVarName, exportName)) {
                    return true;
                }
            }
        } else {
            return checkNodeForAxiosCall(node.body, importVarName, exportName);
        }
    }

    // Check block statement body
    if (node.type === "BlockStatement" && node.body) {
        for (const stmt of node.body) {
            if (checkNodeForAxiosCall(stmt, importVarName, exportName)) {
                return true;
            }
        }
    }

    // Check expressions
    if (node.expression) {
        return checkNodeForAxiosCall(node.expression, importVarName, exportName);
    }

    // Check argument/callee for nested calls
    if (node.callee) {
        if (checkNodeForAxiosCall(node.callee, importVarName, exportName)) {
            return true;
        }
    }

    // Check arguments
    if (node.arguments && Array.isArray(node.arguments)) {
        for (const arg of node.arguments) {
            if (checkNodeForAxiosCall(arg, importVarName, exportName)) {
                return true;
            }
        }
    }

    // Check init value for variable declarators
    if (node.init) {
        return checkNodeForAxiosCall(node.init, importVarName, exportName);
    }

    // Check right side of assignment
    if (node.right) {
        return checkNodeForAxiosCall(node.right, importVarName, exportName);
    }

    return false;
};

/**
 * Check if a variable is exported with a given export name
 */
const checkIfVariableIsExported = (ast: any, exportName: string, varName: string): boolean => {
    let isExported = false;

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
                const exportsObj = path.node.arguments[1];

                for (const prop of exportsObj.properties) {
                    if (prop.type === "ObjectProperty") {
                        let currentExportName = "";
                        if (prop.key.type === "Identifier") {
                            currentExportName = prop.key.name;
                        } else if (prop.key.type === "StringLiteral") {
                            currentExportName = prop.key.value;
                        }

                        if (currentExportName === exportName) {
                            // Check if it returns varName
                            if (
                                prop.value.type === "FunctionExpression" ||
                                prop.value.type === "ArrowFunctionExpression"
                            ) {
                                if (prop.value.body && prop.value.body.type === "BlockStatement") {
                                    for (const stmt of prop.value.body.body) {
                                        if (
                                            stmt.type === "ReturnStatement" &&
                                            stmt.argument &&
                                            stmt.argument.type === "Identifier" &&
                                            stmt.argument.name === varName
                                        ) {
                                            isExported = true;
                                            return;
                                        }
                                    }
                                } else if (
                                    prop.value.body &&
                                    prop.value.body.type === "Identifier" &&
                                    prop.value.body.name === varName
                                ) {
                                    isExported = true;
                                    return;
                                }
                            }
                        }
                    }
                }
            }
        },
    });

    return isExported;
};

/**
 * Extract API calls made using the axios instance
 */
const extractApiCalls = (
    ast: any,
    chunkCode: string,
    importVarName: string,
    exportName: string,
    chunkId: string,
    chunks: Chunks,
    directory: string,
    thirdArgName: string
): void => {
    const chunk = chunks[chunkId];
    const functionFile = `${directory}/${chunk.file}`;

    traverse(ast, {
        CallExpression(path) {
            const callee = path.node.callee;
            let isTargetCall = false;

            // Check for: (0, importVar.exportName)({...})
            if (
                callee.type === "SequenceExpression" &&
                callee.expressions.length === 2 &&
                callee.expressions[0].type === "NumericLiteral" &&
                callee.expressions[0].value === 0 &&
                callee.expressions[1].type === "MemberExpression" &&
                callee.expressions[1].object.type === "Identifier" &&
                callee.expressions[1].object.name === importVarName &&
                callee.expressions[1].property.type === "Identifier" &&
                callee.expressions[1].property.name === exportName
            ) {
                isTargetCall = true;
            }

            // Check for: importVar.exportName({...})
            if (
                callee.type === "MemberExpression" &&
                callee.object.type === "Identifier" &&
                callee.object.name === importVarName &&
                callee.property.type === "Identifier" &&
                callee.property.name === exportName
            ) {
                isTargetCall = true;
            }

            if (isTargetCall && path.node.arguments.length > 0) {
                const configArg = path.node.arguments[0];

                if (configArg.type === "ObjectExpression") {
                    let url = "";
                    let method = "";
                    let data = "";
                    let params = "";
                    let headers = "";

                    for (const prop of configArg.properties) {
                        if (prop.type === "ObjectProperty" && prop.key.type === "Identifier") {
                            const propName = prop.key.name;

                            // Use resolveNodeValue for better resolution with webpack chunk context
                            const resolvedValue = resolveNodeValue(
                                prop.value,
                                path.scope,
                                chunkCode.substring(prop.value.start, prop.value.end),
                                "axios",
                                chunkCode,
                                chunks,
                                thirdArgName
                            );

                            if (propName === "url") {
                                // Handle both string and resolved values
                                if (typeof resolvedValue === "string") {
                                    url = resolvedValue;
                                } else {
                                    url = JSON.stringify(resolvedValue);
                                }
                            } else if (propName === "method") {
                                if (typeof resolvedValue === "string") {
                                    method = resolvedValue.replace(/"/g, "").toUpperCase();
                                } else {
                                    method = String(resolvedValue).replace(/"/g, "").toUpperCase();
                                }
                            } else if (propName === "data") {
                                if (typeof resolvedValue === "object" && resolvedValue !== null) {
                                    data = JSON.stringify(resolvedValue);
                                } else {
                                    data = String(resolvedValue);
                                }
                            } else if (propName === "params") {
                                if (typeof resolvedValue === "object" && resolvedValue !== null) {
                                    params = JSON.stringify(resolvedValue);
                                } else {
                                    params = String(resolvedValue);
                                }
                            } else if (propName === "headers") {
                                if (typeof resolvedValue === "object" && resolvedValue !== null) {
                                    headers = JSON.stringify(resolvedValue);
                                } else {
                                    headers = String(resolvedValue);
                                }
                            }
                        }
                    }

                    // Find line number
                    const codeFileContent = fs.readFileSync(functionFile, "utf-8");
                    const callSnippet = chunkCode.substring(path.node.start, path.node.end);
                    let functionFileLine = -1;

                    const lines = codeFileContent.split("\n");
                    for (let i = 0; i < lines.length; i++) {
                        if (lines[i].includes(callSnippet.trim().substring(0, Math.min(callSnippet.length, 30)))) {
                            functionFileLine = i + 1;
                            break;
                        }
                    }

                    // Log the found API call
                    printMsg(
                        MSG.Warn,
                        `        [+] Found API call in chunk ${chunkId} ("${functionFile}":${functionFileLine})`
                    );
                    if (url) printMsg(MSG.Header, `            URL: ${url}`);
                    if (method) printMsg(MSG.Info, `            Method: ${method}`);
                    if (data) printMsg(MSG.Info, `            Data: ${data}`);
                    if (params) printMsg(MSG.Info, `            Params: ${params}`);
                    if (headers) printMsg(MSG.Info, `            Headers: ${headers}`);

                    // Add to global collection
                    let parsedHeaders = {};
                    if (headers) {
                        try {
                            parsedHeaders = JSON.parse(headers);
                        } catch (e) {
                            // If JSON parsing fails, use the raw string
                            parsedHeaders = { _raw: headers };
                        }
                    }

                    globals.addOpenapiOutput({
                        url: url || "",
                        method: method || "",
                        path: url || "",
                        headers: parsedHeaders,
                        body: data || params || "",
                        chunkId: chunkId,
                        functionFile: functionFile,
                        functionFileLine: functionFileLine,
                    });
                }
            }
        },
    });
};

export default traceAxiosInstanceExports;
