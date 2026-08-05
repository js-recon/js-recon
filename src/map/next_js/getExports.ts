import { Chunks } from "../../utility/interfaces.js";
import parser from "@babel/parser";
import _traverse from "@babel/traverse";
import { ArrowFunctionExpression, FunctionDeclaration } from "@babel/types";
const traverse = (_traverse.default ?? _traverse) as typeof _traverse.default;
import { printMsg, MSG } from "../../utility/printMsg.js";

/**
 * Gets the exports of each chunk.
 * @param {Chunks} chunks - A dictionary of chunk names to chunk objects.
 * @returns {Promise<Chunks>} - A promise that resolves with a dictionary of chunk names to chunk objects with their exports.
 */
const getExports = async (chunks: Chunks): Promise<Chunks> => {
    printMsg(MSG.Header, "[i] Getting exports");

    const chunkCopy = chunks;

    // iterate through the chunks
    for (const chunk of Object.values(chunks)) {
        // get the chunk code
        const chunkCode = chunk.code;

        // parse it with ast
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

        // declare the exportname var
        let chunkSecondArg: string;
        let chunkThirdArg: string;

        // get the second and the third argument of the function
        traverse(ast, {
            enter(path) {
                let funcNode: FunctionDeclaration | ArrowFunctionExpression | null = null;
                if (path.isFunctionDeclaration()) {
                    funcNode = path.node;
                } else if (path.isAssignmentExpression() && path.node.right.type === "ArrowFunctionExpression") {
                    funcNode = path.node.right;
                }

                if (funcNode && funcNode.params.length >= 2) {
                    const secondParam = funcNode.params[1];
                    if (secondParam.type === "Identifier") {
                        chunkSecondArg = secondParam.name;
                    }
                }

                if (funcNode && funcNode.params.length >= 3) {
                    const thirdParam = funcNode.params[2];
                    if (thirdParam.type === "Identifier") {
                        chunkThirdArg = thirdParam.name;
                    }
                }

                if (chunkSecondArg && chunkThirdArg) {
                    path.stop();
                }
            },
        });

        if (!chunkSecondArg) {
            continue;
        }

        const chunkExports: string[] = [];

        // first of all, it is exported something like this:
        // chunkThirdArg.<something>(secondArg, {default: ..., key2: ...})
        // we need to get the names like 'default', 'key2', etc
        traverse(ast, {
            CallExpression(path) {
                const { node } = path;
                if (
                    node.callee.type === "MemberExpression" &&
                    node.callee.object.type === "Identifier" &&
                    node.callee.object.name === chunkThirdArg &&
                    node.arguments.length >= 2 &&
                    node.arguments[0].type === "Identifier" &&
                    node.arguments[0].name === chunkSecondArg &&
                    node.arguments[1].type === "ObjectExpression"
                ) {
                    // get the names of the properties
                    node.arguments[1].properties.forEach((property) => {
                        if (property.type !== "SpreadElement" && property.key.type === "Identifier") {
                            chunkExports.push(property.key.name);
                        }
                    });
                }
            },
        });

        // now, iterate again, and find the different instance
        // it should be something like Object.defineProperty

        chunkCopy[chunk.id].exports = chunkExports;
    }

    return chunkCopy;
};

export default getExports;
