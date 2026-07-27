import fs from "fs";
import parser from "@babel/parser";
import _traverse from "@babel/traverse";
const traverse = (_traverse.default ?? _traverse) as typeof _traverse.default;
import { Chunks } from "../../utility/interfaces.js";
import { printMsg, MSG } from "../../utility/printMsg.js";

/**
 * Checks for client-side paths in a mapped JSON file.
 *
 * @param {string} filePath - The path to the mapped JSON file
 * @returns {Promise<string[]>} - A promise that resolves to an array of client-side paths
 */
const client_mappedJsonFile = async (filePath: string): Promise<string[]> => {
    printMsg(MSG.Header, "[i] Checking for client-side paths from mapped JSON file");

    // open the file and load the chunks
    const chunks: Chunks = JSON.parse(fs.readFileSync(filePath, "utf-8"));

    let chunksCopy = chunks;

    let foundPaths: string[] = [];

    // iterate over the chunks
    for (const [key, value] of Object.entries(chunks)) {
        // see if the chunk code string contains window.__NEXT_P string
        if (value.code.includes("window.__NEXT_P")) {
            let ast;
            try {
                ast = parser.parse(value.code, {
                    sourceType: "unambiguous",
                    plugins: ["jsx", "typescript"],
                    errorRecovery: true,
                });
            } catch (err) {
                printMsg(MSG.Err, `[!] Failed to parse chunk ${key}: ${err}`);
                continue;
            }

            traverse(ast, {
                CallExpression(path) {
                    const callee = path.node.callee;

                    // Check if it's a .push() call
                    if (
                        callee.type === "MemberExpression" &&
                        callee.property.type === "Identifier" &&
                        callee.property.name === "push"
                    ) {
                        const obj = callee.object;

                        // Check if the object of the push call is an assignment expression
                        if (obj.type === "AssignmentExpression" && obj.left.type === "MemberExpression") {
                            const assignment = obj;
                            const memberExpr = assignment.left as any;

                            // Check for window.__NEXT_P
                            if (
                                memberExpr.object.type === "Identifier" &&
                                memberExpr.object.name === "window" &&
                                memberExpr.property.type === "Identifier" &&
                                memberExpr.property.name === "__NEXT_P"
                            ) {
                                // Check for the logical expression on the right side of the assignment
                                if (
                                    assignment.right.type === "LogicalExpression" &&
                                    assignment.right.operator === "||"
                                ) {
                                    const logicalExpr = assignment.right;

                                    // Check that the logical expression is `window.__NEXT_P || []`
                                    if (
                                        logicalExpr.left.type === "MemberExpression" &&
                                        logicalExpr.left.object.type === "Identifier" &&
                                        logicalExpr.left.object.name === "window" &&
                                        logicalExpr.left.property.type === "Identifier" &&
                                        logicalExpr.left.property.name === "__NEXT_P" &&
                                        logicalExpr.right.type === "ArrayExpression" &&
                                        logicalExpr.right.elements.length === 0
                                    ) {
                                        // Now, get the arguments of the .push() call
                                        const pushArgs = path.node.arguments;
                                        if (pushArgs.length > 0 && pushArgs[0].type === "ArrayExpression") {
                                            const firstArg = pushArgs[0];
                                            if (firstArg.elements.length > 0) {
                                                const element = firstArg.elements[0];
                                                if (element.type === "StringLiteral") {
                                                    printMsg(
                                                        MSG.Run,
                                                        `[+] Found client-side path: ${element.value}`
                                                    );
                                                    if (chunksCopy[key].description === "none") {
                                                        chunksCopy[key].description =
                                                            "Client-side path definition: " + element.value;
                                                    }
                                                    foundPaths.push(element.value);
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                },
            });
        }
    }

    // write the chunk to the output file
    const chunks_json = JSON.stringify(chunksCopy, null, 2);
    fs.writeFileSync(filePath, chunks_json);

    return foundPaths;
};

export default client_mappedJsonFile;
