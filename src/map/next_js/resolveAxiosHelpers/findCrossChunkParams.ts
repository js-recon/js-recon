import { Chunks } from "../../../utility/interfaces.js";
import _traverse from "@babel/traverse";
import * as fs from "fs";
import parser from "@babel/parser";
import { astNodeToJsonString } from "./astNodeToJsonString.js";
import pathModule from "path";
import { printMsg, MSG } from "../../../utility/printMsg.js";

const traverse = (_traverse.default ?? _traverse) as typeof _traverse.default;

/**
 * Find parameters passed to exported endpoint functions from other chunks
 * that import this chunk
 *
 * @param {string} sourceChunkName - The name of the chunk that exports the endpoint
 * @param {string} exportName - The export name of the endpoint function
 * @param {Chunks} chunks - A dictionary of chunk names to chunk objects
 * @param {string} directory - The directory of the chunk files
 * @returns {Array<{chunkId: string, params: string, file: string, line: number}>} - Array of parameters found in other chunks
 */
export const findCrossChunkParameters = (
    sourceChunkName: string,
    exportName: string,
    chunks: Chunks,
    directory: string
): Array<{ chunkId: string; params: string; file: string; line: number }> => {
    const result: Array<{ chunkId: string; params: string; file: string; line: number }> = [];

    // Find chunks that import the source chunk
    const importingChunks = Object.entries(chunks).filter(([_, chunk]) => {
        return chunk.imports && chunk.imports.includes(sourceChunkName);
    });

    if (importingChunks.length === 0) {
        return result;
    }

    // Process each importing chunk
    for (const [importingChunkName, importingChunk] of importingChunks) {
        const chunkCode = importingChunk.code;
        let ast;
        try {
            ast = parser.parse(chunkCode, {
                sourceType: "unambiguous",
                plugins: ["jsx", "typescript"],
                errorRecovery: true,
            });
        } catch {
            continue;
        }

        // Step 1: Find the third parameter in function declarations
        let thirdArg = "";
        traverse(ast, {
            enter(path) {
                if (path.isFunctionDeclaration() && path.node.params.length >= 3) {
                    const thirdParam = path.node.params[2];
                    if (thirdParam.type === "Identifier") {
                        thirdArg = thirdParam.name;
                        path.stop();
                    }
                } else if (
                    path.isAssignmentExpression() &&
                    path.node.right.type === "ArrowFunctionExpression" &&
                    path.node.right.params.length >= 3
                ) {
                    const thirdParam = path.node.right.params[2];
                    if (thirdParam.type === "Identifier") {
                        thirdArg = thirdParam.name;
                        path.stop();
                    }
                }
            },
        });

        if (!thirdArg) {
            continue;
        }

        // Step 2: Find variable assignments using the third arg and source chunk
        // Example: <new_var> = <third_arg>(<chunk_that_exports>);
        const moduleVars: { [key: string]: string } = {};
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
                    // Found a variable assigned from the third arg function
                    // e.g., let moduleVar = n(21222);
                    if (
                        path.node.init.arguments[0].type === "NumericLiteral" &&
                        path.node.init.arguments[0].value.toString() === sourceChunkName
                    ) {
                        moduleVars[path.node.id.name] = sourceChunkName;
                    } else if (
                        path.node.init.arguments[0].type === "StringLiteral" &&
                        path.node.init.arguments[0].value === sourceChunkName
                    ) {
                        moduleVars[path.node.id.name] = sourceChunkName;
                    }
                }
            },
        });

        if (Object.keys(moduleVars).length === 0) {
            continue;
        }

        // Step 3: Find calls to the exported function and extract parameters
        // Examples:
        // - await (0, <new_var>.<something>)();
        // - (0, <new_var>.<something>)(e)
        for (const moduleVar of Object.keys(moduleVars)) {
            traverse(ast, {
                CallExpression(path) {
                    // Helper function to extract and record parameters
                    const extractAndRecordParams = (callNode, context = "") => {
                        if (callNode.arguments && callNode.arguments.length > 0) {
                            // Extract parameters
                            const params = astNodeToJsonString(callNode.arguments[0], chunkCode);

                            // Find the line number in the file
                            const functionFile = `${directory}/${importingChunk.file}`;
                            const codeFileContent = fs.readFileSync(functionFile, "utf-8");
                            let functionFileLine = -1;

                            // Extract code snippet for this call
                            const callSnippet = chunkCode.substring(callNode.start, callNode.end);

                            // Find line in file
                            const lines = codeFileContent.split("\n");
                            for (let i = 0; i < lines.length; i++) {
                                if (
                                    lines[i].includes(callSnippet.trim().substring(0, Math.min(callSnippet.length, 30)))
                                ) {
                                    functionFileLine = i + 1;
                                    break;
                                }
                            }

                            // Log the found parameter usage
                            printMsg(
                                MSG.Header,
                                `[+] Found ${context} parameter usage for '${exportName}' in chunk ${importingChunkName} ("${functionFile}":${functionFileLine})`
                            );
                            printMsg(MSG.Info, `    Params: ${params}`);

                            // Add to result
                            result.push({
                                chunkId: importingChunkName,
                                params: params,
                                file: functionFile,
                                line: functionFileLine,
                            });

                            return true;
                        }
                        return false;
                    };

                    // Helper function to check if a node represents a call to our exported function
                    const isTargetExportCall = (calleeNode) => {
                        // Check direct member expression: moduleVar.exportName
                        if (
                            calleeNode.type === "MemberExpression" &&
                            calleeNode.object.type === "Identifier" &&
                            calleeNode.object.name === moduleVar &&
                            calleeNode.property.type === "Identifier" &&
                            calleeNode.property.name === exportName
                        ) {
                            return true;
                        }

                        // Check (0, moduleVar.exportName) pattern
                        if (
                            calleeNode.type === "SequenceExpression" &&
                            calleeNode.expressions.length === 2 &&
                            calleeNode.expressions[0].type === "NumericLiteral" &&
                            calleeNode.expressions[0].value === 0 &&
                            calleeNode.expressions[1].type === "MemberExpression" &&
                            calleeNode.expressions[1].object.type === "Identifier" &&
                            calleeNode.expressions[1].object.name === moduleVar &&
                            calleeNode.expressions[1].property.type === "Identifier" &&
                            calleeNode.expressions[1].property.name === exportName
                        ) {
                            return true;
                        }

                        return false;
                    };

                    // 1. Check for direct calls: (0, m.HE)(e) or m.HE(e)
                    if (isTargetExportCall(path.node.callee)) {
                        extractAndRecordParams(path.node, "direct");
                    }

                    // 2. Check for awaited calls: await (0, m.HE)(e)
                    if (
                        path.parentPath &&
                        path.parentPath.isAwaitExpression() &&
                        isTargetExportCall(path.node.callee)
                    ) {
                        extractAndRecordParams(path.node, "awaited");
                    }

                    // 3. Check for calls wrapped in variable assignments: const result = (0, m.HE)(e)
                    if (
                        path.parentPath &&
                        (path.parentPath.isVariableDeclarator() || path.parentPath.isAssignmentExpression()) &&
                        isTargetExportCall(path.node.callee)
                    ) {
                        extractAndRecordParams(path.node, "assigned");
                    }

                    // 4. Check if we're in a function call where one of the arguments is our target call
                    const checkForParamInFunctionCall = () => {
                        // Get the parent function call
                        const parentCall = path.findParent((p) => p.isCallExpression() && p !== path);
                        if (!parentCall) return false;

                        // Check if any of the arguments to the parent function is a call to our export
                        const parentCallNode = parentCall.node as any;
                        if (parentCallNode.arguments) {
                            for (let i = 0; i < parentCallNode.arguments.length; i++) {
                                const arg = parentCallNode.arguments[i];

                                // Check if the argument is an object with properties
                                if (arg.type === "ObjectExpression") {
                                    for (const prop of arg.properties) {
                                        if (
                                            prop.type === "ObjectProperty" &&
                                            prop.value.type === "CallExpression" &&
                                            isTargetExportCall(prop.value.callee)
                                        ) {
                                            // Found our export being called inside an object passed to another function
                                            extractAndRecordParams(prop.value, "nested in object");
                                            return true;
                                        }
                                    }
                                }
                            }
                        }
                        return false;
                    };
                    checkForParamInFunctionCall();

                    // 5. Look for wrapper functions that call our endpoint function with parameters
                    const parentFunction = path.findParent((p) => p.isFunction());
                    if (parentFunction && path.parentPath && path.parentPath.isCallExpression()) {
                        const parentCall = path.parentPath;

                        // Check if the current call is to our exported function
                        if (isTargetExportCall(path.node.callee) && parentCall.node.arguments.length > 0) {
                            extractAndRecordParams(parentCall.node, "wrapper function");
                        }
                    }

                    // 6. Check for complex assignment patterns: b = async (e) => { (await (0, m.HE)(e)).result... }
                    const checkForComplexAssignments = () => {
                        // Find variable declarations or assignments that are functions
                        const funcDecl = path.findParent((p) => {
                            const pn = p.node as any;
                            return (
                                (p.isVariableDeclarator() || p.isAssignmentExpression()) &&
                                ((pn.init &&
                                    (pn.init.type === "ArrowFunctionExpression" ||
                                        pn.init.type === "FunctionExpression")) ||
                                    (pn.right &&
                                        (pn.right.type === "ArrowFunctionExpression" ||
                                            pn.right.type === "FunctionExpression")))
                            );
                        });

                        if (funcDecl) {
                            // This call is inside a function declaration
                            // Check if this function calls our target export
                            if (isTargetExportCall(path.node.callee)) {
                                extractAndRecordParams(path.node, "complex function");
                            }
                        }

                        return false;
                    };
                    checkForComplexAssignments();

                    // 7. Check for destructuring from the result of our API call: const { result } = await (0, m.HE)(e)
                    if (
                        path.parentPath &&
                        path.parentPath.isAwaitExpression() &&
                        path.parentPath.parentPath &&
                        path.parentPath.parentPath.isVariableDeclarator() &&
                        path.parentPath.parentPath.node.id.type === "ObjectPattern" &&
                        isTargetExportCall(path.node.callee)
                    ) {
                        extractAndRecordParams(path.node, "destructured result");
                    }

                    // 8. Check for property access on the result: (await (0, m.HE)(e)).result
                    if (
                        path.parentPath &&
                        path.parentPath.isAwaitExpression() &&
                        path.parentPath.parentPath &&
                        path.parentPath.parentPath.isMemberExpression() &&
                        isTargetExportCall(path.node.callee)
                    ) {
                        extractAndRecordParams(path.node, "property access");
                    }

                    // 9. Check for conditional expressions: n ? b({ params }) : w({ params })
                    if (
                        path.parentPath &&
                        path.parentPath.isConditionalExpression() &&
                        (path.parentPath.node.consequent === path.node || path.parentPath.node.alternate === path.node)
                    ) {
                        // This call is part of a ternary operation
                        // If there are function calls in either branch, examine them
                        const checkBranch = (branchNode) => {
                            if (branchNode && branchNode.type === "CallExpression") {
                                // Extract object properties that might be parameters
                                if (branchNode.arguments && branchNode.arguments.length > 0) {
                                    const arg = branchNode.arguments[0];
                                    if (arg.type === "ObjectExpression") {
                                        // Found a call with object parameters in conditional
                                        const params = astNodeToJsonString(arg, chunkCode);

                                        // Find the line number in the file
                                        const functionFile = pathModule.join(directory, importingChunk.file);
                                        const codeFileContent = fs.readFileSync(functionFile, "utf-8");
                                        let functionFileLine = -1;

                                        // Extract code snippet for this call
                                        const callSnippet = chunkCode.substring(branchNode.start, branchNode.end);

                                        // Find line in file
                                        const lines = codeFileContent.split("\n");
                                        for (let i = 0; i < lines.length; i++) {
                                            if (
                                                lines[i].includes(
                                                    callSnippet.trim().substring(0, Math.min(callSnippet.length, 30))
                                                )
                                            ) {
                                                functionFileLine = i + 1;
                                                break;
                                            }
                                        }

                                        // Check if the object has references to our export
                                        for (const prop of arg.properties) {
                                            if (
                                                prop.type === "ObjectProperty" &&
                                                prop.value.type === "MemberExpression" &&
                                                prop.value.object &&
                                                prop.value.object.type === "Identifier" &&
                                                prop.value.object.name === "e"
                                            ) {
                                                // This is likely a parameter derived from our export
                                                printMsg(
                                                    MSG.Header,
                                                    `[+] Found conditional branch parameter usage for '${exportName}' in chunk ${importingChunkName} ("${functionFile}":${functionFileLine})`
                                                );
                                                printMsg(MSG.Info, `    Params: ${params}`);

                                                result.push({
                                                    chunkId: importingChunkName,
                                                    params: params,
                                                    file: functionFile,
                                                    line: functionFileLine,
                                                });
                                                return true;
                                            }
                                        }
                                    }
                                }
                            }
                            return false;
                        };

                        checkBranch(path.parentPath.node.consequent);
                        checkBranch(path.parentPath.node.alternate);
                    }
                },
            });
        }
    }

    return result;
};

export default findCrossChunkParameters;
