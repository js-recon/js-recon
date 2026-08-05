import { NodePath } from "@babel/traverse";
import { MemberExpression, Node } from "@babel/types";
import { Chunks } from "../../../utility/interfaces.js";
import * as fs from "fs";
import { resolveNodeValue, substituteVariablesInString } from "../utils.js";
import { astNodeToJsonString } from "./astNodeToJsonString.js";
import { resolveBodyArg } from "./traceBody.js";
import * as globals from "../../../utility/globals.js";
import globalConfig from "../../../globalConfig.js";
import { handleAxiosCreate } from "./handleAxiosCreate.js";
import { getThirdArg, getGlobalInterceptorHeaders } from "../resolveAxios.js";
import { printMsg, MSG } from "../../../utility/printMsg.js";

/**
 * Gets the HTTP method from a method name.
 * @param {string} methodName - The method name.
 * @returns {string | null} - The HTTP method, or null if the method name is not a valid HTTP method.
 */
const getHttpMethod = (methodName: string): string | null => {
    const upperCaseMethod = methodName.toUpperCase();
    const httpMethods = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS", "TRACE", "CONNECT"];
    if (httpMethods.includes(upperCaseMethod)) {
        return upperCaseMethod;
    }
    return null;
};

/**
 * Processes an axios call.
 * @param {NodePath<MemberExpression>} path - The path to the MemberExpression node.
 * @param {string} axiosInstance - The axios instance name.
 * @param {string} chunkCode - The code of the chunk.
 * @param {string} directory - The directory of the chunk file.
 * @param {string} chunkName - The name of the chunk.
 * @param {Chunks} chunks - A dictionary of chunk names to chunk objects.
 * @param {any} ast - The abstract syntax tree of the chunk.
 */
export const processAxiosCall = (
    path: NodePath<MemberExpression>,
    axiosInstance: string,
    chunkCode: string,
    directory: string,
    chunkName: string,
    chunks: Chunks,
    ast: any
) => {
    if (
        path.node.object.type !== "MemberExpression" ||
        path.node.object.object.type !== "Identifier" ||
        path.node.object.object.name !== axiosInstance
    ) {
        return;
    }

    const codeSnippet = chunkCode.split("\n")[path.node.loc.start.line - 1];
    const secondProp = path.node.property.type === "Identifier" ? path.node.property.name : "";

    if (secondProp === "create") {
        if (handleAxiosCreate(path, ast, chunkCode, directory, chunkName, chunks)) {
            path.skip(); // Skip further traversal if it was an axios.create() call
        }
        return;
    }

    const callMethod = getHttpMethod(secondProp);
    if (!callMethod) {
        if (!globalConfig.axiosNonHttpMethods.includes(secondProp)) {
            // console.error(chalk.yellow(`[!] Unknown or unhandled axios method: ${secondProp}`));
        }
        return;
    }

    let callUrl: string;
    let callBody: string;
    let callHeaders: { [key: string]: string } = {};

    // Get the webpack require function name (third arg) for enhanced resolution
    const thirdArgName = getThirdArg(ast);

    // Axios HTTP-method calling conventions:
    //   axios.get(url[, config])           — body lives only inside config.data (rare)
    //   axios.delete(url[, config])        — same as get
    //   axios.head/options(url[, config])  — same as get
    //   axios.post(url[, body[, config]])  — body is the 2nd argument
    //   axios.put/patch(url, body, config) — same as post
    // For body-less methods we must treat arg[1] as config, not body, otherwise we
    // mislabel query/header params as request bodies.
    const bodyBearingMethods = new Set(["POST", "PUT", "PATCH"]);
    const methodHasBodyArg = bodyBearingMethods.has(callMethod);

    if (path.parentPath.isCallExpression()) {
        const args = path.parentPath.node.arguments;
        if (args.length > 0) {
            const axiosFirstArg = args[0];
            const axiosFirstArgText = chunkCode.slice(axiosFirstArg.start, axiosFirstArg.end);

            const concatRegex = /\".*\"(\\.concat\(.+\))+/;
            // Bound the probe length before running this regex against attacker-controlled bundle
            // text: the nested `(\.concat\(.+\))+` quantifiers are catastrophically backtracking on
            // crafted input, so a maliciously long argument could hang the analysis pipeline.
            const MAX_CONCAT_PROBE_LENGTH = 2000;
            if (axiosFirstArgText.length <= MAX_CONCAT_PROBE_LENGTH && concatRegex.test(axiosFirstArgText)) {
                callUrl = resolveNodeValue(
                    axiosFirstArg,
                    path.scope,
                    axiosFirstArgText,
                    "axios",
                    chunkCode,
                    chunks,
                    thirdArgName
                );
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

            // Substitute any [var X] or [MemberExpression -> X] placeholders with actual values from the chunk
            if (typeof callUrl === "string" && (callUrl.includes("[var ") || callUrl.includes("[MemberExpression"))) {
                callUrl = substituteVariablesInString(callUrl, chunkCode, chunks, thirdArgName);
            }
        }

        if (args.length > 1) {
            const axiosSecondArg = args[1];
            if (axiosSecondArg.type === "ObjectExpression") {
                // For body-less methods this whole object IS the config; for body-bearing
                // methods only the inner `data` property is the body.
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
                    callBody = resolveBodyArg(dataProp.value, path.parentPath, ast, chunkCode, chunks, chunkName);
                } else if (!dataProp && methodHasBodyArg) {
                    const otherProps = axiosSecondArg.properties.filter(
                        (p) => !(p.type === "ObjectProperty" && p.key.type === "Identifier" && p.key.name === "headers")
                    );
                    if (otherProps.length > 0) {
                        const bodyObject = { ...axiosSecondArg, properties: otherProps };
                        callBody = astNodeToJsonString(bodyObject, chunkCode);
                    }
                }
            } else if (methodHasBodyArg) {
                callBody = resolveBodyArg(axiosSecondArg, path.parentPath, ast, chunkCode, chunks, chunkName);
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

    // Merge globally-applied interceptor headers with per-call headers. Per-call
    // values win on overlap since they're explicit overrides.
    const interceptorHeaders = getGlobalInterceptorHeaders();
    const mergedHeaders: { [key: string]: string } = { ...interceptorHeaders, ...callHeaders };

    printMsg(MSG.Info, `[+] Found axios call in chunk ${chunkName} ("${functionFile}":${functionFileLine})`);
    printMsg(MSG.Run, `    URL: ${callUrl}`);
    printMsg(MSG.Run, `    Method: ${callMethod}`);
    if (callBody) {
        printMsg(MSG.Run, `    Body: ${callBody}`);
    }
    if (Object.keys(mergedHeaders).length > 0) {
        printMsg(MSG.Run, `    Headers: ${JSON.stringify(mergedHeaders)}`);
    }

    globals.addOpenapiOutput({
        url: callUrl || "",
        method: callMethod || "",
        path: callUrl || "",
        headers: mergedHeaders || {},
        body: callBody || "",
        chunkId: chunkName,
        functionFile: functionFile,
        functionFileLine: functionFileLine,
    });
};
