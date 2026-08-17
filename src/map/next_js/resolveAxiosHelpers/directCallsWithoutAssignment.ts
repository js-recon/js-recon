import traverse from "@babel/traverse";
import * as t from "@babel/types";
import { Chunks } from "../../../utility/interfaces.js";
import { processDirectAxiosCall } from "./processDirectAxiosCall.js";

/**
 * Finds and processes direct Axios calls that are not assigned to a variable.
 * @param ast - The Abstract Syntax Tree of the code.
 * @param thirdArg - The name of the third argument function.
 * @param axiosLibraryId - The ID of the Axios library.
 * @param chunkCode - The code of the chunk.
 * @param directory - The directory of the chunk.
 * @param chunkName - The name of the chunk.
 * @param chunks - All the chunks.
 */
export const directCallsWithoutAssignment = (
    ast: t.Node,
    thirdArg: string,
    axiosLibraryId: string,
    chunkCode: string,
    directory: string,
    chunkName: string,
    chunks: Chunks
) => {
    let axiosVarName: string | null = null;

    // Find variable assignment: let N = a(5323)
    traverse(ast, {
        VariableDeclarator(path) {
            if (
                path.node.init &&
                t.isCallExpression(path.node.init) &&
                t.isIdentifier(path.node.init.callee) &&
                path.node.init.callee.name === thirdArg &&
                path.node.init.arguments.length === 1 &&
                t.isNumericLiteral(path.node.init.arguments[0]) &&
                path.node.init.arguments[0].value.toString() === axiosLibraryId &&
                t.isIdentifier(path.node.id)
            ) {
                axiosVarName = path.node.id.name;
                path.stop();
            }
        },
    });

    if (axiosVarName) {
        traverse(ast, {
            MemberExpression(path) {
                if (
                    t.isMemberExpression(path.node.object) &&
                    t.isIdentifier(path.node.object.object) &&
                    path.node.object.object.name === axiosVarName &&
                    t.isIdentifier(path.node.object.property) &&
                    path.node.object.property.name === "Z" &&
                    t.isIdentifier(path.node.property)
                ) {
                    processDirectAxiosCall(path, chunkCode, directory, chunkName, chunks, ast);
                }
            },
        });
    }
};
