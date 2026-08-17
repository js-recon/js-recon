import { Node } from "@babel/types";
import traverse from "@babel/traverse";
/**
 * Resolves a function identifier to its declaration node in the given AST.
 *
 * Given an identifier node, this function traverses the given AST and returns the
 * function declaration node associated with the identifier. The traversal is stopped
 * once a match is found.
 *
 * @param identifier - The identifier node to resolve
 * @param ast - The AST to traverse
 * @returns The function declaration node associated with the identifier, or undefined if not found
 */
export function resolveFunctionIdentifier(identifier: Node, ast: Node): Node | undefined {
    let declarationNode: Node | undefined;

    if (identifier.type !== "Identifier") {
        return undefined;
    }

    traverse(ast, {
        FunctionDeclaration(path) {
            if (path.node.id && path.node.id.name === identifier.name) {
                declarationNode = path.node;
                path.stop();
            }
        },
        VariableDeclarator(path) {
            if (path.node.id.type === "Identifier" && path.node.id.name === identifier.name) {
                if (
                    path.node.init &&
                    (path.node.init.type === "ArrowFunctionExpression" || path.node.init.type === "FunctionExpression")
                ) {
                    declarationNode = path.node.init;
                    path.stop();
                }
            }
        },
    });

    return declarationNode;
}
