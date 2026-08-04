import { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import { Chunks } from "../../../utility/interfaces.js";
import * as fs from "fs";
import { resolveNodeValue, resolveStringOps, substituteVariablesInString } from "../utils.js";
import { astNodeToJsonString } from "./astNodeToJsonString.js";
import { resolveBodyArg } from "./traceBody.js";
import * as globals from "../../../utility/globals.js";
import globalConfig from "../../../globalConfig.js";
import { getThirdArg, getGlobalInterceptorHeaders } from "../resolveAxios.js";
import { printMsg, MSG } from "../../../utility/printMsg.js";

const getHttpMethod = (methodName: string): string | null => {
    const upperCaseMethod = methodName.toUpperCase();
    const httpMethods = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"];
    if (httpMethods.includes(upperCaseMethod)) {
        return upperCaseMethod;
    }
    return null;
};

export const processDirectAxiosCall = (
    path: NodePath<t.MemberExpression>,
    chunkCode: string,
    directory: string,
    chunkName: string,
    chunks: Chunks,
    ast: t.Node
) => {
    const callMethodName = t.isIdentifier(path.node.property) ? path.node.property.name : "";
    const callMethod = getHttpMethod(callMethodName);

    if (!callMethod) {
        if (!globalConfig.axiosNonHttpMethods.includes(callMethodName)) {
            // console.error(chalk.yellow(`[!] Unknown or unhandled axios method: ${callMethodName}`));
        }
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

            const concatRegex = /\".*\"(\\.concat\(.+\))+/;
            if (concatRegex.test(axiosFirstArgText)) {
                callUrl = resolveStringOps(axiosFirstArgText);
            } else if (t.isStringLiteral(axiosFirstArg)) {
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

        // Axios calling convention is method-dependent. For body-less methods
        // (GET/DELETE/HEAD/OPTIONS) `args[1]` is the config, not a body — surfacing
        // it as "Body" misclassifies headers and query params as request payloads.
        const bodyBearingMethods = new Set(["POST", "PUT", "PATCH"]);
        const methodHasBodyArg = bodyBearingMethods.has(callMethod);
        if (methodHasBodyArg && args.length > 1) {
            const axiosSecondArg = args[1];
            callBody = resolveBodyArg(axiosSecondArg, path.parentPath, ast, chunkCode, chunks, chunkName);
        }

        if (args.length > 2) {
            const axiosThirdArg = args[2];
            if (t.isObjectExpression(axiosThirdArg)) {
                const headersProp = axiosThirdArg.properties.find(
                    (p) => t.isObjectProperty(p) && t.isIdentifier(p.key) && p.key.name === "headers"
                );

                if (t.isObjectProperty(headersProp) && t.isObjectExpression(headersProp.value)) {
                    const newHeaders = {};
                    for (const header of headersProp.value.properties) {
                        if (t.isObjectProperty(header)) {
                            let key: string;
                            if (t.isIdentifier(header.key)) {
                                key = header.key.name;
                            } else if (t.isStringLiteral(header.key)) {
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
            }
        }
    }

    const functionFile = `${directory}/${chunks[chunkName].file}`;
    const codeFileContent = fs.readFileSync(functionFile, "utf-8");
    const codeSnippet = chunkCode.split("\n")[path.node.loc.start.line - 1];
    let functionFileLine = -1;
    const lines = codeFileContent.split("\n");
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(codeSnippet.trim())) {
            functionFileLine = i + 1;
            break;
        }
    }

    const interceptorHeaders = getGlobalInterceptorHeaders();
    const mergedHeaders: { [key: string]: string } = { ...interceptorHeaders, ...callHeaders };

    printMsg(MSG.Info, `[+] Found direct axios call in chunk ${chunkName} ("${functionFile}":${functionFileLine})`);
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
