import { Node } from "@babel/types";

/**
 * Recursively converts an AST node to a JSON-like string representation.
 *
 * The function walks the AST tree, resolving each node's value as a JSON-like string.
 * For example, an ObjectExpression node will be resolved to a string like "{key1: value1, key2: value2}".
 * A SpreadElement will be resolved to "...<resolved argument value>".
 * A MemberExpression will be resolved to a string like "<resolved property name>".
 *
 * @param node - The AST node to be converted
 * @param code - The original source code string
 * @returns A JSON-like string representation of the AST node
 */
export const astNodeToJsonString = (node: Node, code: string): string => {
    if (!node) {
        return '""';
    }

    switch (node.type) {
        case "ObjectExpression": {
            const props = node.properties
                .map((prop) => {
                    if (prop.type === "ObjectProperty") {
                        const key = astNodeToJsonString(prop.key, code);
                        const value = astNodeToJsonString(prop.value, code);
                        return `${key}: ${value}`;
                    } else if (prop.type === "SpreadElement") {
                        // Skip spread elements — they're code artifacts, not real body keys.
                        return null;
                    }
                    return null; // Or handle other property types if necessary
                })
                .filter(Boolean);
            return `{${props.join(", ")}}`;
        }
        case "ArrayExpression": {
            const elements = node.elements.map((elem) => astNodeToJsonString(elem, code));
            return `[${elements.join(", ")}]`;
        }
        case "StringLiteral": {
            return JSON.stringify(node.value);
        }
        case "NumericLiteral": {
            return String(node.value);
        }
        case "BooleanLiteral": {
            return String(node.value);
        }
        case "NullLiteral": {
            return "null";
        }
        case "Identifier": {
            return `"${node.name}"`;
        }
        case "MemberExpression": {
            // Reconstruct the member expression as a string, removing newlines
            return `"${code.slice(node.start, node.end).replace(/\n\s*/g, " ")}"`;
        }
        default: {
            // For any other node types, slice the original code, remove newlines, and wrap in quotes
            return `"${code.slice(node.start, node.end).replace(/\n\s*/g, " ")}"`;
        }
    }
};
