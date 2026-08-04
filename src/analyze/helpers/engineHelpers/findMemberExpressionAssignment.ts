import { Node } from "@babel/types";
import _traverse from "@babel/traverse";
const traverse = (_traverse.default ?? _traverse) as typeof _traverse.default;

/**
 * Finds an assignment expression where the left side is a member expression with a property that matches the given name.
 * Traverses the given node and its children to find a match.
 * @param node The AST node to traverse.
 * @param toMatch The name of the property to match on the left side of the assignment.
 * @returns The assignment expression node if found, otherwise undefined.
 */
export const findMemberExpressionAssignment = (node: Node, toMatch: string): Node | undefined => {
    let foundNode: Node | undefined;

    traverse(node, {
        // The node passed in is often a function subtree rather than a Program/File,
        // and isn't accompanied by a real parent Scope/parentPath. Without noScope,
        // Babel's scope crawling can walk a broken parent-scope chain for some node
        // shapes (e.g. an assignment nested inside an IfStatement) and throw
        // "Couldn't find a Program" from deep inside Scope#getProgramParent. This
        // visitor never reads path.scope, so skipping scope construction is safe.
        noScope: true,
        AssignmentExpression(path) {
            const assignmentNode = path.node;

            if (
                assignmentNode.left?.type === "MemberExpression" &&
                assignmentNode.right?.type === "MemberExpression" &&
                (assignmentNode.left as any).property?.type === "Identifier" &&
                (assignmentNode.left as any).property?.name === toMatch
            ) {
                foundNode = assignmentNode;
                // Stop further traversal once a match is found
                path.stop();
            }
        },
    });

    return foundNode;
};
