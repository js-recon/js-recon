import { Node } from "@babel/types";
import traverse from "@babel/traverse";
import { printMsg, MSG } from "../../../utility/printMsg.js";
/**
 * Finds the variable name of the axios instance used in a chunk.
 * @param {Node} ast - The abstract syntax tree of the chunk.
 * @param {string} thirdArg - The third argument of the function.
 * @param {string} axiosImportedToChunk - The name of the chunk that exports the axios instance.
 * @param {string} chunkName - The name of the chunk.
 * @returns {string} The variable name of the axios instance used in the chunk.
 */
export const findAxiosInstance = (
    ast: Node,
    thirdArg: string,
    axiosImportedToChunk: string,
    chunkName: string
): string => {
    let axiosInstance = "";

    if (thirdArg !== "") {
        traverse(ast, {
            VariableDeclarator(path) {
                if (path.node.id.type === "Identifier") {
                    const varName = path.node.id.name;
                    const assignmentValue = path.node.init;
                    if (
                        assignmentValue?.type === "CallExpression" &&
                        assignmentValue.callee.type === "Identifier" &&
                        assignmentValue.callee.name === thirdArg
                    ) {
                        const firstArg = assignmentValue.arguments[0];
                        if (firstArg && (firstArg.type === "StringLiteral" || firstArg.type === "NumericLiteral")) {
                            const thisFunctionAssignmentValue = firstArg.value.toString();
                            if (thisFunctionAssignmentValue === axiosImportedToChunk) {
                                printMsg(MSG.Run, `[✓] ${chunkName} uses axios client initialized in ${varName}`);
                                axiosInstance = varName;
                                path.stop();
                            }
                        }
                    }
                }
            },
        });
    }

    return axiosInstance;
};
