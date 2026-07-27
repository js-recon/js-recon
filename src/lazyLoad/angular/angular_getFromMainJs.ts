import makeRequest from "../../utility/makeReq.js";
import _traverse from "@babel/traverse";
import * as parser from "@babel/parser";
import resolvePath from "../../utility/resolvePath.js";
import { printMsg, MSG } from "../../utility/printMsg.js";

const traverse = (_traverse.default ?? _traverse) as typeof _traverse.default;

/**
 * Parses the main.js file of an Angular application to extract lazy-loaded module paths.
 * It traverses the AST to find dynamic import() expressions and extracts the chunk paths.
 *
 * @param mainJsUrl The full URL to the main.js file.
 * @returns A promise that resolves to an array of strings, where each string is a path to a lazy-loaded chunk.
 */
const angular_getFromMainJs = async (mainJsUrl: string): Promise<string[]> => {
    printMsg(MSG.Header, `[i] Analyzing main.js from ${mainJsUrl}`);

    let foundUrls: string[] = [];

    const mainJsRes = await makeRequest(mainJsUrl, {});
    const mainJsBody = await mainJsRes.text();

    // Parse the main.js file content into an AST
    const ast = parser.parse(mainJsBody, {
        sourceType: "unambiguous",
        plugins: ["jsx", "typescript"],
        errorRecovery: true,
    });

    let importDeclarationPaths: string[] = [];

    // Traverse the AST to find dynamic import expressions
    traverse(ast, {
        CallExpression(path) {
            // Check if the callee is an import()
            if (path.node.callee.type === "Import") {
                const importArg = path.node.arguments[0];
                // Ensure the first argument is a string literal and extract its value
                if (importArg && importArg.type === "StringLiteral") {
                    importDeclarationPaths.push(importArg.value);
                }
            }
        },
    });

    // now, resolve the paths
    for (const importDeclarationPath of importDeclarationPaths) {
        foundUrls.push(resolvePath(mainJsUrl, importDeclarationPath));
    }

    return foundUrls;
};

export default angular_getFromMainJs;
