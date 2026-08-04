import fs from "fs";
import path from "path";
import parser from "@babel/parser";
import _traverse from "@babel/traverse";
import { printMsg, MSG } from "../../utility/printMsg.js";
const traverse = (_traverse.default ?? _traverse) as typeof _traverse.default;

/**
 * Searches for href attributes in JavaScript files to discover client-side paths.
 *
 * Parses JavaScript files using AST traversal to find object properties with 'href' keys
 * and extracts their values, which typically represent client-side routes or URLs.
 * Handles various patterns including string literals and concatenation calls.
 *
 * @param directory - The directory path containing JavaScript files to analyze
 * @returns Promise that resolves to an array of discovered paths/URLs
 */
const client_jsFilesHref = async (directory: string): Promise<string[]> => {
    printMsg(MSG.Header, "[i] Searching for `href` in the JS chunks");
    let discoveredPaths = [];
    // index all the files in the directory
    let files;
    files = fs.readdirSync(directory, { recursive: true });

    // filter out the directories
    files = files.filter((file) => !fs.statSync(path.join(directory, file)).isDirectory());

    // filter out the subsequent requests files
    files = files.filter((file) => !file.startsWith("___subsequent_requests"));

    for (const file of files) {
        const code = fs.readFileSync(path.join(directory, file), "utf8");

        // parse the code with ast
        let ast;
        try {
            ast = parser.parse(code, {
                sourceType: "unambiguous",
                plugins: ["jsx", "typescript"],
                errorRecovery: true,
            });

            traverse(ast, {
                ObjectProperty(path) {
                    const keyNode = path.node.key;
                    let keyName;
                    if (keyNode.type === "Identifier") {
                        keyName = keyNode.name;
                    } else if (keyNode.type === "StringLiteral") {
                        keyName = keyNode.value;
                    }

                    if (keyName !== "href") {
                        return;
                    }

                    const valueNode = path.node.value;
                    let hrefValue = null;

                    if (valueNode.type === "StringLiteral") {
                        hrefValue = valueNode.value;
                    } else if (
                        valueNode.type === "CallExpression" &&
                        valueNode.callee.type === "MemberExpression" &&
                        valueNode.callee.property.type === "Identifier" &&
                        valueNode.callee.property.name === "concat"
                    ) {
                        // It's a .concat() call.
                        // Let's find string literal arguments that look like paths.
                        const pathArg = valueNode.arguments.find(
                            (arg) =>
                                arg.type === "StringLiteral" &&
                                ((arg as any).value.startsWith("/") || (arg as any).value.startsWith("http"))
                        );

                        if (pathArg && pathArg.type === "StringLiteral") {
                            hrefValue = pathArg.value;
                        } else {
                            // Handle fallback case: e.g. "".concat(s || "/docs/guides")
                            const logicalExprArg = valueNode.arguments.find(
                                (arg) => arg.type === "LogicalExpression" && (arg as any).operator === "||"
                            );
                            if (logicalExprArg && (logicalExprArg as any).right?.type === "StringLiteral") {
                                hrefValue = (logicalExprArg as any).right.value;
                            }
                        }
                    }

                    if (hrefValue) {
                        const isPath = hrefValue.startsWith("/") || hrefValue.startsWith("http");
                        if (isPath && !discoveredPaths.includes(hrefValue)) {
                            discoveredPaths.push(hrefValue);
                        }
                    }
                },
            });
        } catch (err) {
            continue;
        }
    }

    return discoveredPaths;
};

export default client_jsFilesHref;
