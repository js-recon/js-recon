import traverse from "@babel/traverse";
import { Node } from "@babel/types";

/**
 * Finds direct assignment expressions or variable declarations for a given identifier node.
 *
 * Searches through the AST scope to locate where a specific identifier is assigned a value,
 * either through assignment expressions (e.g., `x = value`) or variable declarations (e.g., `var x = value`).
 *
 * @param nodeToFind - The identifier node to search for assignments
 * @param scope - The AST scope to search within
 * @returns The assignment or declaration node if found, null otherwise
 */
export function findDirectAssignment(nodeToFind: Node, scope: Node): Node | null {
    let assignmentNode: Node | null = null;

    traverse(scope, {
        AssignmentExpression(path) {
            // Check if the left-hand side of the assignment matches the nodeToFind
            if (
                path.node.left.type === "Identifier" &&
                nodeToFind.type === "Identifier" &&
                path.node.left.name === nodeToFind.name
            ) {
                assignmentNode = path.node;
                path.stop(); // Stop traversal once found
            }
        },
        VariableDeclarator(path) {
            // Check if the variable being declared matches the nodeToFind
            if (
                path.node.id.type === "Identifier" &&
                nodeToFind.type === "Identifier" &&
                path.node.id.name === nodeToFind.name
            ) {
                assignmentNode = path.node;
                path.stop(); // Stop traversal once found
            }
        },
    });

    return assignmentNode;
}
