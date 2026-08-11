import { NodePath } from "@babel/traverse";
import { MemberExpression, CallExpression, VariableDeclarator, ObjectProperty } from "@babel/types";
import _traverse from "@babel/traverse";
import * as fs from "fs";
import * as fsPath from "path";
import { Chunks } from "../../../utility/interfaces.js";
import * as globals from "../../../utility/globals.js";
import { astNodeToJsonString } from "./astNodeToJsonString.js";
import { resolveNodeValue, resolveStringOps } from "../utils.js";
import { processExportedEndpoints } from "./processExportedEndpoints.js";
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
 * Handles a pattern like 'n(7066).Z.create()' where Z is a property and create() is a method call.
 * This identifies when an axios client is created in this pattern and tracks its usage.
 *
 * @param {NodePath<CallExpression>} path - The path to the CallExpression node.
 * @param {string} chunkCode - The code of the chunk.
 * @param {string} directory - The directory of the chunk file.
 * @param {string} chunkName - The name of the chunk.
 * @param {Chunks} chunks - A dictionary of chunk names to chunk objects.
 * @param {string[]} axiosExportedTo - Array of chunks that have an Axios client.
 * @returns {string} The variable name of the created axios instance, or empty string if not found.
 */
export const handleZDotCreate = (
    path: NodePath<CallExpression>,
    chunkCode: string,
    directory: string,
    chunkName: string,
    chunks: Chunks,
    axiosExportedTo: string[]
): string => {
    // Return if not in the correct pattern
    if (!path.node.callee || path.node.callee.type !== "MemberExpression") {
        return "";
    }

    const calleeNode = path.node.callee;

    // Check if the pattern matches n(...).Z.create()
    if (
        calleeNode.property.type !== "Identifier" ||
        calleeNode.property.name !== "create" ||
        calleeNode.object.type !== "MemberExpression" ||
        calleeNode.object.property.type !== "Identifier" ||
        calleeNode.object.property.name !== "Z" ||
        calleeNode.object.object.type !== "CallExpression"
    ) {
        return "";
    }

    // Extract the module ID (e.g., 7066 in n(7066))
    let moduleId: string;
    const callExpr = calleeNode.object.object;
    if (callExpr.arguments.length > 0) {
        if (callExpr.arguments[0].type === "NumericLiteral") {
            moduleId = callExpr.arguments[0].value.toString();
        } else if (callExpr.arguments[0].type === "StringLiteral") {
            moduleId = callExpr.arguments[0].value;
        } else {
            return ""; // Unsupported argument type
        }
    } else {
        return ""; // No arguments
    }

    // Check if this module ID is in axiosExportedTo
    if (!axiosExportedTo.includes(moduleId)) {
        return ""; // Not an axios client
    }

    let axiosCreateVarName = "";
    let axiosCreateLineNumber = 0;

    // Check if this is a variable assignment (let x = n(7066).Z.create())
    if (path.parentPath.isAssignmentExpression()) {
        const assignment = path.parentPath.node;
        if (assignment.left.type === "Identifier") {
            axiosCreateVarName = assignment.left.name;
            const axiosCreateLineContent = chunkCode.split("\n")[assignment.loc.start.line - 1];

            const chunkFile = fs.readFileSync(fsPath.join(directory, chunks[chunkName].file), "utf-8");
            axiosCreateLineNumber = findLineNumberByContent(chunkFile, axiosCreateLineContent);
        }
    } else if (path.parentPath.isVariableDeclarator()) {
        const varDeclarator = path.parentPath.node;
        if (varDeclarator.id.type === "Identifier") {
            axiosCreateVarName = varDeclarator.id.name;

            const axiosCreateLineContent = chunkCode.split("\n")[varDeclarator.loc.start.line - 1];

            const chunkFile = fs.readFileSync(fsPath.join(directory, chunks[chunkName].file), "utf-8");
            axiosCreateLineNumber = findLineNumberByContent(chunkFile, axiosCreateLineContent);
        }
    }

    if (axiosCreateVarName !== "") {
        printMsg(
            MSG.Run,
            `[✓] .Z.create() assigned to '${axiosCreateVarName}' in chunk ${chunkName} ("${directory}/${chunks[chunkName].file}":${axiosCreateLineNumber})`
        );

        // After detecting Z.create(), check for exported endpoint wrappers
        if (chunks[chunkName].exports && chunks[chunkName].exports.length > 1) {
            // Get the AST from the program parent scope to use for traversal
            const ast = path.scope.getProgramParent().path.node;
            processExportedEndpoints(axiosCreateVarName, chunkCode, directory, chunkName, chunks, ast);
        }

        // Extract configuration options from the create() call, like baseURL
        let axiosCreateBaseURL: string;
        const axiosCreateArgs = path.node.arguments;

        // Check if the create() method has configuration options
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

        return axiosCreateVarName;
    }

    return "";
};

/**
 * Gets the HTTP method from a method name, supporting Axios form methods.
 *
 * @param {string} methodName - The method name from Axios.
 * @returns {string | null} - The HTTP method, or null if not a valid HTTP method.
 */
export const getHttpMethodWithForm = (methodName: string): string | null => {
    const upperCaseMethod = methodName.toUpperCase();
    const httpMethods = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS", "TRACE", "CONNECT"];

    if (httpMethods.includes(upperCaseMethod)) {
        return upperCaseMethod;
    }

    // Handle special form methods
    if (methodName === "postForm") return "POST";
    if (methodName === "putForm") return "PUT";
    if (methodName === "patchForm") return "PATCH";

    return null;
};

/**
 * Process an API call made with a Z.create() axios instance.
 *
 * @param {NodePath<MemberExpression>} path - The path to the MemberExpression node.
 * @param {string} axiosInstance - The axios instance variable name.
 * @param {string} chunkCode - The code of the chunk.
 * @param {string} directory - The directory of the chunk file.
 * @param {string} chunkName - The name of the chunk.
 * @param {Chunks} chunks - A dictionary of chunk names to chunk objects.
 * @param {any} ast - The abstract syntax tree of the chunk.
 */
export const processZDotCreateCall = (
    path: NodePath<MemberExpression>,
    axiosInstance: string,
    chunkCode: string,
    directory: string,
    chunkName: string,
    chunks: Chunks,
    ast: any
) => {
    if (path.node.object.type !== "Identifier" || path.node.object.name !== axiosInstance) {
        return;
    }

    const codeSnippet = chunkCode.split("\n")[path.node.loc.start.line - 1];
    const methodName = path.node.property.type === "Identifier" ? path.node.property.name : "";

    const callMethod = getHttpMethodWithForm(methodName);
    if (!callMethod) {
        // Unknown or non-HTTP method
        return;
    }

    let callUrl: string;
    let callBody: string;
    let callHeaders: { [key: string]: string } = {};

    // Get the webpack require function name (third arg) for enhanced resolution
    const thirdArgName = getThirdArg(ast);

    if (path.parentPath.isCallExpression()) {
        const args = path.parentPath.node.arguments;
        if (args.length > 0) {
            const axiosFirstArg = args[0];
            const axiosFirstArgText = chunkCode.slice(axiosFirstArg.start, axiosFirstArg.end);

            const concatRegex = /"[^"]*"(?:\.concat\([^()]*\))+/;
            // Bound the probe length before running this regex against attacker-controlled bundle
            // text: the nested `(\.concat\(.+\))+` quantifiers are catastrophically backtracking on
            // crafted input, so a maliciously long argument could hang the analysis pipeline.
            const MAX_CONCAT_PROBE_LENGTH = 2000;
            if (axiosFirstArgText.length <= MAX_CONCAT_PROBE_LENGTH && concatRegex.test(axiosFirstArgText)) {
                callUrl = resolveStringOps(axiosFirstArgText);
            } else if (axiosFirstArg.type === "StringLiteral") {
                callUrl = axiosFirstArg.value;
            } else {
                callUrl = resolveNodeValue(
                    axiosFirstArg,
                    path.scope,
                    axiosFirstArgText,
                    "axios",
                    chunkCode,
                    chunks,
                    thirdArgName
                );
            }
        }

        if (args.length > 1) {
            const axiosSecondArg = args[1];
            if (axiosSecondArg.type === "ObjectExpression") {
                const headersProp = axiosSecondArg.properties.find(
                    (p) => p.type === "ObjectProperty" && p.key.type === "Identifier" && p.key.name === "headers"
                );
                const dataProp = axiosSecondArg.properties.find(
                    (p) => p.type === "ObjectProperty" && p.key.type === "Identifier" && p.key.name === "data"
                );

                if (
                    headersProp &&
                    headersProp.type === "ObjectProperty" &&
                    headersProp.value.type === "ObjectExpression"
                ) {
                    const newHeaders = {};
                    for (const header of headersProp.value.properties) {
                        if (header.type === "ObjectProperty") {
                            let key: string;
                            if (header.key.type === "Identifier") {
                                key = header.key.name;
                            } else if (header.key.type === "StringLiteral") {
                                key = header.key.value;
                            } else {
                                key = `[unresolved key]`;
                            }
                            const value = astNodeToJsonString(header.value, chunkCode);
                            newHeaders[key] = value;
                        }
                    }
                    callHeaders = newHeaders;
                }

                if (dataProp && dataProp.type === "ObjectProperty") {
                    callBody = astNodeToJsonString(dataProp.value, chunkCode);
                } else if (!dataProp) {
                    const otherProps = axiosSecondArg.properties.filter(
                        (p) => !(p.type === "ObjectProperty" && p.key.type === "Identifier" && p.key.name === "headers")
                    );
                    if (otherProps.length > 0) {
                        const bodyObject = { ...axiosSecondArg, properties: otherProps };
                        callBody = astNodeToJsonString(bodyObject, chunkCode);
                    }
                }
            } else {
                callBody = astNodeToJsonString(axiosSecondArg, chunkCode);
            }
        }
    }

    const functionFile = `${directory}/${chunks[chunkName].file}`;
    const codeFileContent = fs.readFileSync(functionFile, "utf-8");
    let functionFileLine = -1;
    const lines = codeFileContent.split("\n");
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(codeSnippet.trim())) {
            functionFileLine = i + 1;
            break;
        }
    }

    printMsg(MSG.Info, `[+] Found Z.create() axios call in chunk ${chunkName} ("${functionFile}":${functionFileLine})`);
    printMsg(MSG.Run, `    URL: ${callUrl}`);
    printMsg(MSG.Run, `    Method: ${callMethod}`);
    if (callBody) {
        printMsg(MSG.Run, `    Body: ${callBody}`);
    }
    if (Object.keys(callHeaders).length > 0) {
        printMsg(MSG.Run, `    Headers: ${JSON.stringify(callHeaders)}`);
    }

    globals.addOpenapiOutput({
        url: callUrl || "",
        method: callMethod || "",
        path: callUrl || "",
        headers: callHeaders || {},
        body: callBody || "",
        chunkId: chunkName,
        functionFile: functionFile,
        functionFileLine: functionFileLine,
    });
};
