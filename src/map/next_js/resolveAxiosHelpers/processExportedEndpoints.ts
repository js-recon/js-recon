import { Chunks } from "../../../utility/interfaces.js";
import traverse from "@babel/traverse";
import { getHttpMethodWithForm } from "./handleZDotCreate.js";
import { astNodeToJsonString } from "./astNodeToJsonString.js";
import * as fs from "fs";
import * as globals from "../../../utility/globals.js";
import * as parser from "@babel/parser";
import { findCrossChunkParameters } from "./findCrossChunkParams.js";
import { printMsg, MSG } from "../../../utility/printMsg.js";

/**
 * Process exported functions that wrap axios HTTP methods.
 * This function looks for patterns where exported functions call axios methods with endpoints.
 *
 * @param {string} axiosInstance - The variable name of the axios instance created with Z.create().
 * @param {string} chunkCode - The code of the chunk.
 * @param {string} directory - The directory of the chunk file.
 * @param {string} chunkName - The name of the chunk.
 * @param {Chunks} chunks - A dictionary of chunk names to chunk objects.
 * @param {any} ast - The abstract syntax tree of the chunk.
 */
export const processExportedEndpoints = (
    axiosInstance: string,
    chunkCode: string,
    directory: string,
    chunkName: string,
    chunks: Chunks,
    ast: any
) => {
    // Variables to track exports and their corresponding function variables
    const exportMap: { [key: string]: string } = {};
    const axiosMethodVars: { [key: string]: string } = {};
    let axiosMethodsFound = false;

    // Step 1: Find the destructuring assignment for axios methods
    // Example: let {request: s, get: o, post: a} = i
    traverse(ast, {
        VariableDeclarator(path) {
            if (
                path.node.init &&
                path.node.init.type === "Identifier" &&
                path.node.init.name === axiosInstance &&
                path.node.id.type === "ObjectPattern"
            ) {
                // Found the destructuring of the axios instance
                axiosMethodsFound = true;

                for (const prop of path.node.id.properties) {
                    if (
                        prop.type === "ObjectProperty" &&
                        prop.key.type === "Identifier" &&
                        prop.value.type === "Identifier"
                    ) {
                        const methodName = prop.key.name; // e.g., "get", "post"
                        const varName = prop.value.name; // e.g., "o", "a"

                        // Store the mapping of variable names to HTTP methods
                        axiosMethodVars[varName] = methodName;
                    }
                }
            }
        },
    });

    if (!axiosMethodsFound) {
        return; // No axios method destructuring found
    }

    // Step 2: Find the exports and their corresponding variable names
    // Example: n.d(t, { FX: function() { return l } })
    traverse(ast, {
        CallExpression(path) {
            const callee = path.node.callee;
            if (
                callee.type === "MemberExpression" &&
                callee.object.type === "Identifier" &&
                callee.property.type === "Identifier" &&
                callee.property.name === "d" &&
                path.node.arguments.length >= 2 &&
                path.node.arguments[1].type === "ObjectExpression"
            ) {
                // This is likely the n.d(t, {exports}) pattern
                const exportsObj = path.node.arguments[1];

                for (const prop of exportsObj.properties) {
                    if (
                        prop.type === "ObjectProperty" &&
                        (prop.value.type === "FunctionExpression" || prop.value.type === "ArrowFunctionExpression")
                    ) {
                        // Get the export name
                        let exportName = "";
                        if (prop.key.type === "Identifier") {
                            exportName = prop.key.name;
                        } else if (prop.key.type === "StringLiteral") {
                            exportName = prop.key.value;
                        }

                        // Find the return statement in the function body
                        if (prop.value.body && prop.value.body.type === "BlockStatement") {
                            for (const stmt of prop.value.body.body) {
                                if (
                                    stmt.type === "ReturnStatement" &&
                                    stmt.argument &&
                                    stmt.argument.type === "Identifier"
                                ) {
                                    // Map the export name to its returned variable
                                    exportMap[exportName] = stmt.argument.name;
                                }
                            }
                        } else if (prop.value.body && prop.value.body.type === "Identifier") {
                            // Arrow function with implicit return
                            exportMap[exportName] = prop.value.body.name;
                        }
                    }
                }
            }
        },
    });

    // Step 3: Find the variable declarations for the exported functions
    // Example: l = () => o("/something")
    for (const exportKey in exportMap) {
        const varName = exportMap[exportKey];

        traverse(ast, {
            AssignmentExpression(path) {
                if (
                    path.node.left.type === "Identifier" &&
                    path.node.left.name === varName &&
                    (path.node.right.type === "ArrowFunctionExpression" ||
                        path.node.right.type === "FunctionExpression")
                ) {
                    const funcExpr = path.node.right;
                    let callExpr;

                    // Handle different function body types
                    if (funcExpr.body.type === "BlockStatement") {
                        // Function with block body, look for return statement
                        for (const stmt of funcExpr.body.body) {
                            if (
                                stmt.type === "ReturnStatement" &&
                                stmt.argument &&
                                stmt.argument.type === "CallExpression"
                            ) {
                                callExpr = stmt.argument;
                                break;
                            }
                        }
                    } else if (funcExpr.body.type === "CallExpression") {
                        // Arrow function with implicit return
                        callExpr = funcExpr.body;
                    }

                    if (callExpr && callExpr.callee.type === "Identifier" && axiosMethodVars[callExpr.callee.name]) {
                        // Found an axios method call, extract endpoint details
                        const axiosMethodVar = callExpr.callee.name;
                        const axiosMethod = axiosMethodVars[axiosMethodVar];
                        const httpMethod = getHttpMethodWithForm(axiosMethod);

                        if (!httpMethod) {
                            return; // Skip if HTTP method is not recognized
                        }

                        let endpoint = "";
                        let params = "";

                        // Extract the URL/endpoint
                        if (callExpr.arguments.length > 0) {
                            if (callExpr.arguments[0].type === "StringLiteral") {
                                endpoint = callExpr.arguments[0].value;
                            } else {
                                endpoint = astNodeToJsonString(callExpr.arguments[0], chunkCode);
                            }
                        }

                        // Extract parameters/body if present
                        if (callExpr.arguments.length > 1) {
                            params = astNodeToJsonString(callExpr.arguments[1], chunkCode);
                        }

                        // Find line number in source file
                        const functionFile = `${directory}/${chunks[chunkName].file}`;
                        const codeFileContent = fs.readFileSync(functionFile, "utf-8");
                        let functionFileLine = -1;

                        // Extract the code snippet for this arrow function
                        const arrowFuncSnippet = chunkCode.substring(path.node.start, path.node.end);

                        // Look for this snippet in the file
                        const lines = codeFileContent.split("\n");
                        for (let i = 0; i < lines.length; i++) {
                            if (
                                lines[i].includes(
                                    arrowFuncSnippet.trim().substring(0, Math.min(arrowFuncSnippet.length, 30))
                                )
                            ) {
                                functionFileLine = i + 1;
                                break;
                            }
                        }

                        // Log the found exported endpoint
                        printMsg(
                            MSG.Header,
                            `[+] Found exported endpoint '${exportKey}' in chunk ${chunkName} ("${functionFile}":${functionFileLine})`
                        );
                        printMsg(MSG.Warn, `    Export: ${exportKey} => ${varName}`);
                        printMsg(MSG.Run, `    URL: ${endpoint}`);
                        printMsg(MSG.Run, `    Method: ${httpMethod}`);

                        if (params) {
                            printMsg(MSG.Run, `    Params/Body: ${params}`);
                        }

                        // Find cross-chunk parameters for this endpoint
                        const crossChunkParams = findCrossChunkParameters(chunkName, exportKey, chunks, directory);

                        // Add to the API collection
                        globals.addOpenapiOutput({
                            url: endpoint || "",
                            method: httpMethod || "",
                            path: endpoint || "",
                            headers: {}, // Headers would typically be set at the axios instance level
                            body: params || "",
                            chunkId: chunkName,
                            functionFile: functionFile,
                            functionFileLine: functionFileLine,
                            crossChunkParams: crossChunkParams,
                        });
                    }
                }
            },
            VariableDeclarator(path) {
                if (
                    path.node.id.type === "Identifier" &&
                    path.node.id.name === varName &&
                    path.node.init &&
                    (path.node.init.type === "ArrowFunctionExpression" || path.node.init.type === "FunctionExpression")
                ) {
                    const funcExpr = path.node.init;
                    let callExpr;

                    // Handle different function body types
                    if (funcExpr.body.type === "BlockStatement") {
                        // Function with block body, look for return statement
                        for (const stmt of funcExpr.body.body) {
                            if (
                                stmt.type === "ReturnStatement" &&
                                stmt.argument &&
                                stmt.argument.type === "CallExpression"
                            ) {
                                callExpr = stmt.argument;
                                break;
                            }
                        }
                    } else if (funcExpr.body.type === "CallExpression") {
                        // Arrow function with implicit return
                        callExpr = funcExpr.body;
                    }

                    if (callExpr && callExpr.callee.type === "Identifier" && axiosMethodVars[callExpr.callee.name]) {
                        // Found an axios method call, extract endpoint details
                        const axiosMethodVar = callExpr.callee.name;
                        const axiosMethod = axiosMethodVars[axiosMethodVar];
                        const httpMethod = getHttpMethodWithForm(axiosMethod);

                        if (!httpMethod) {
                            return; // Skip if HTTP method is not recognized
                        }

                        let endpoint = "";
                        let params = "";

                        // Extract the URL/endpoint
                        if (callExpr.arguments.length > 0) {
                            if (callExpr.arguments[0].type === "StringLiteral") {
                                endpoint = callExpr.arguments[0].value;
                            } else {
                                endpoint = astNodeToJsonString(callExpr.arguments[0], chunkCode);
                            }
                        }

                        // Extract parameters/body if present
                        if (callExpr.arguments.length > 1) {
                            params = astNodeToJsonString(callExpr.arguments[1], chunkCode);
                        }

                        // Find line number in source file
                        const functionFile = `${directory}/${chunks[chunkName].file}`;
                        const codeFileContent = fs.readFileSync(functionFile, "utf-8");
                        let functionFileLine = -1;

                        // Extract the code snippet for this variable declaration
                        const varDeclSnippet = chunkCode.substring(path.node.start, path.node.end);

                        // Look for this snippet in the file
                        const lines = codeFileContent.split("\n");
                        for (let i = 0; i < lines.length; i++) {
                            if (
                                lines[i].includes(
                                    varDeclSnippet.trim().substring(0, Math.min(varDeclSnippet.length, 30))
                                )
                            ) {
                                functionFileLine = i + 1;
                                break;
                            }
                        }

                        // Log the found exported endpoint
                        printMsg(
                            MSG.Header,
                            `[+] Found exported endpoint '${exportKey}' in chunk ${chunkName} ("${functionFile}":${functionFileLine})`
                        );
                        printMsg(MSG.Warn, `    Export: ${exportKey} => ${varName}`);
                        printMsg(MSG.Run, `    URL: ${endpoint}`);
                        printMsg(MSG.Run, `    Method: ${httpMethod}`);

                        if (params) {
                            printMsg(MSG.Run, `    Params/Body: ${params}`);
                        }

                        // Find cross-chunk parameters for this endpoint
                        const crossChunkParams = findCrossChunkParameters(chunkName, exportKey, chunks, directory);

                        // Add to the API collection
                        globals.addOpenapiOutput({
                            url: endpoint || "",
                            method: httpMethod || "",
                            path: endpoint || "",
                            headers: {}, // Headers would typically be set at the axios instance level
                            body: params || "",
                            chunkId: chunkName,
                            functionFile: functionFile,
                            functionFileLine: functionFileLine,
                            crossChunkParams: crossChunkParams,
                        });
                    }
                }
            },
        });
    }
};

export default processExportedEndpoints;
