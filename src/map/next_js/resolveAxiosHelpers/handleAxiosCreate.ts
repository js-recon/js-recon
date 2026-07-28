import { NodePath } from "@babel/traverse";
import { MemberExpression } from "@babel/types";
import _traverse from "@babel/traverse";
import * as fs from "fs";
import * as fsPath from "path";
import { Chunks } from "../../../utility/interfaces.js";
import * as globals from "../../../utility/globals.js";
import { astNodeToJsonString } from "./astNodeToJsonString.js";
import { resolveNodeValue } from "../utils.js";
import { traceAxiosInstanceExports } from "./traceAxiosInstanceExports.js";
import { getThirdArg } from "../resolveAxios.js";
import { printMsg, MSG } from "../../../utility/printMsg.js";

const traverse = (_traverse.default ?? _traverse) as typeof _traverse.default;

/**
 * Finds the line number of a target line content in a given file content.
 * The line number is 1-indexed.
 *
 * @param {string} fileContent - The content of the file to search in.
 * @param {string} targetLineContent - The target line content to search for.
 * @returns {number} - The line number of the target line content, or 0 if not found.
 */
const findLineNumberByContent = (fileContent: string, targetLineContent: string): number => {
    const lines = fileContent.split("\n");
    const trimmedTarget = targetLineContent.trim();
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim() === trimmedTarget) {
            return i + 1;
        }
    }
    return 0;
};

/**
 * Handles an axios.create() call in a chunk.
 * @param {NodePath<MemberExpression>} path - The path to the MemberExpression node.
 * @param {any} ast - The abstract syntax tree of the chunk.
 * @param {string} chunkCode - The code of the chunk.
 * @param {string} directory - The directory of the chunk file.
 * @param {string} chunkName - The name of the chunk.
 * @param {Chunks} chunks - A dictionary of chunk names to chunk objects.
 * @returns {boolean} - True if this was an axios.create() call and was handled, false otherwise.
 */
export const handleAxiosCreate = (
    path: NodePath<MemberExpression>,
    ast: any,
    chunkCode: string,
    directory: string,
    chunkName: string,
    chunks: Chunks
): boolean => {
    let axiosCreateVarName = "";
    let axiosCreateLineNumber = 0;

    // Find the wrapper function that contains the axios.create() call
    // Pattern: p = ((t) => { let e = n.Z.create({...}) })
    // We want 'p', not 'e'

    // First, traverse up to find if we're inside a function
    let wrapperFunction = path.findParent((p) => p.isArrowFunctionExpression() || p.isFunctionExpression());

    if (wrapperFunction) {
        // Now check if this function is assigned to a variable or wrapped in a call expression
        let assignmentParent = wrapperFunction.findParent(
            (p) => p.isAssignmentExpression() || p.isVariableDeclarator()
        );

        if (assignmentParent) {
            if (assignmentParent.isAssignmentExpression()) {
                // Pattern: p = ((t) => {...})
                const assignment = assignmentParent.node;
                if (assignment.left.type === "Identifier") {
                    axiosCreateVarName = assignment.left.name;
                    const axiosCreateLineContent = chunkCode.split("\n")[assignment.loc.start.line - 1];
                    const chunkFile = fs.readFileSync(fsPath.join(directory, chunks[chunkName].file), "utf-8");
                    axiosCreateLineNumber = findLineNumberByContent(chunkFile, axiosCreateLineContent);
                }
            } else if (assignmentParent.isVariableDeclarator()) {
                // Pattern: const p = ((t) => {...})
                const varDeclarator = assignmentParent.node;
                if (varDeclarator.id.type === "Identifier") {
                    axiosCreateVarName = varDeclarator.id.name;
                    const axiosCreateLineContent = chunkCode.split("\n")[varDeclarator.loc.start.line - 1];
                    const chunkFile = fs.readFileSync(fsPath.join(directory, chunks[chunkName].file), "utf-8");
                    axiosCreateLineNumber = findLineNumberByContent(chunkFile, axiosCreateLineContent);
                }
            }
        }
    } else {
        // Fallback to old logic if not wrapped in a function
        if (path.parentPath.isCallExpression() && path.parentPath.parentPath.isVariableDeclarator()) {
            const varDeclarator = path.parentPath.parentPath.node;
            if (varDeclarator.id.type === "Identifier") {
                axiosCreateVarName = varDeclarator.id.name;
                const axiosCreateLineContent = chunkCode.split("\n")[varDeclarator.loc.start.line - 1];
                const chunkFile = fs.readFileSync(fsPath.join(directory, chunks[chunkName].file), "utf-8");
                axiosCreateLineNumber = findLineNumberByContent(chunkFile, axiosCreateLineContent);
            }
        }
    }

    if (axiosCreateVarName !== "") {
        printMsg(
            MSG.Run,
            `[✓] axios.create() assigned to '${axiosCreateVarName}' in chunk ${chunkName} ("${directory}/${chunks[chunkName].file}":${axiosCreateLineNumber})`
        );

        // Trace if this axios instance is exported and re-used in other chunks
        printMsg(MSG.Info, `    [→] Tracing axios instance '${axiosCreateVarName}' exports...`);
        traceAxiosInstanceExports(chunkName, axiosCreateVarName, chunks, directory);

        // get the arguments of this axios create. Like .create({})
        let axiosCreateBaseURL: string;
        const axiosCreateArgs = (path.parentPath.node as any).arguments;

        // iterate through it, and check if the first arg is an object
        if (axiosCreateArgs.length > 0 && axiosCreateArgs[0].type === "ObjectExpression") {
            const axiosCreateArgsObj = axiosCreateArgs[0];
            for (const property of axiosCreateArgsObj.properties) {
                if (property.type === "ObjectProperty" && property.key.type === "Identifier") {
                    if (property.key.name === "baseURL") {
                        axiosCreateBaseURL = property.value.type === "StringLiteral" ? property.value.value : "";
                    }
                }
            }
        }

        traverse(ast, {
            CallExpression(callPath) {
                if (callPath.node.callee.type === "Identifier" && callPath.node.callee.name === axiosCreateVarName) {
                    const axiosCreateLineContent = chunkCode.split("\n")[callPath.node.loc.start.line - 1];

                    const chunkFile = fs.readFileSync(fsPath.join(directory, chunks[chunkName].file), "utf-8");
                    const axiosCreateCallLineNumber = findLineNumberByContent(chunkFile, axiosCreateLineContent);

                    // if there are no arguments, return
                    if (callPath.node.arguments && callPath.node.arguments.length === 0) {
                        return;
                    }

                    const firstArg = callPath.node.arguments[0];
                    let axiosCreateCallUrl: string;
                    let axiosCreateCallMethod: string;
                    let axiosCreateCallParams: any;
                    let axiosCreateCallHeaders: any;

                    printMsg(
                        MSG.Info,
                        `[+] Found axios.create() call in chunk ${chunkName} ("${directory}/${chunks[chunkName].file}":${axiosCreateCallLineNumber})`
                    );

                    if (firstArg.type === "ObjectExpression") {
                        for (const property of firstArg.properties) {
                            if (property.type === "ObjectProperty" && property.key.type === "Identifier") {
                                if (property.key.name === "url") {
                                    if (property.value.type === "StringLiteral") {
                                        axiosCreateCallUrl = property.value.value;
                                    } else {
                                        const scope = callPath.scope;
                                        const nodeCode = chunkCode.slice(property.value.start, property.value.end);
                                        const thirdArgName = getThirdArg(ast);
                                        axiosCreateCallUrl = resolveNodeValue(
                                            property.value,
                                            scope,
                                            nodeCode,
                                            "axios",
                                            chunkCode,
                                            chunks,
                                            thirdArgName
                                        );
                                    }
                                } else if (property.key.name === "method" && property.value.type === "StringLiteral") {
                                    axiosCreateCallMethod = property.value.value;
                                } else if (property.key.name === "params") {
                                    axiosCreateCallParams = astNodeToJsonString(property.value, chunkCode);
                                } else if (property.key.name === "headers") {
                                    if (property.value.type === "ObjectExpression") {
                                        axiosCreateCallHeaders = astNodeToJsonString(property.value, chunkCode);
                                    }
                                }
                            }
                        }
                    }

                    if (axiosCreateCallUrl) printMsg(MSG.Run, `    URL: ${axiosCreateBaseURL}${axiosCreateCallUrl}`);
                    if (axiosCreateCallMethod) printMsg(MSG.Run, `    Method: ${axiosCreateCallMethod.toUpperCase()}`);
                    if (axiosCreateCallParams) printMsg(MSG.Run, `    Params: ${axiosCreateCallParams}`);
                    if (axiosCreateCallHeaders) printMsg(MSG.Run, `    Headers: ${axiosCreateCallHeaders}`);

                    globals.addOpenapiOutput({
                        url: axiosCreateCallUrl || "",
                        method: axiosCreateCallMethod || "",
                        path: axiosCreateCallUrl || "",
                        headers: axiosCreateCallHeaders || {},
                        body: axiosCreateCallParams || "",
                        chunkId: chunkName,
                        functionFile: `${directory}/${chunks[chunkName].file}`,
                        functionFileLine: axiosCreateCallLineNumber,
                    });
                }
            },
        });
        return true; // Indicates that this was an axios.create() call and was handled.
    }
    return false;
};
