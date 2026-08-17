import { describe, it, expect } from "vitest";
import * as parser from "@babel/parser";
import traverse from "@babel/traverse";
import { renderObjectExpression, renderValueNode } from "../../map/vue_js/taint_utils.js";

/**
 * Parse a JS snippet, traverse it, and capture the first ObjectExpression node
 * along with its scope and the original code string.
 */
function parseObjectExpr(code: string): { node: any; scope: any; code: string } | null {
    const ast = parser.parse(code, {
        sourceType: "module",
        plugins: ["jsx", "typescript"],
        errorRecovery: true,
    });
    let captured: { node: any; scope: any } | null = null;
    traverse(ast, {
        ObjectExpression(path) {
            if (!captured) {
                captured = { node: path.node, scope: path.scope };
                path.stop();
            }
        },
    });
    if (!captured) return null;
    return { ...(captured as { node: any; scope: any }), code };
}

/**
 * Parse a JS snippet and capture the first expression node and scope
 * that is NOT an ObjectExpression (used for renderValueNode tests).
 */
function parseValueExpr(code: string): { node: any; scope: any; code: string } | null {
    const ast = parser.parse(`const _v = ${code};`, {
        sourceType: "module",
        plugins: ["jsx", "typescript"],
        errorRecovery: true,
    });
    let captured: { node: any; scope: any } | null = null;
    traverse(ast, {
        VariableDeclarator(path) {
            if (!captured && path.node.init) {
                captured = { node: path.node.init, scope: path.scope };
                path.stop();
            }
        },
    });
    if (!captured) return null;
    return { ...(captured as { node: any; scope: any }), code: `const _v = ${code};` };
}

describe("renderObjectExpression", () => {
    it("returns null for non-ObjectExpression nodes", () => {
        const result = renderObjectExpression({ type: "StringLiteral", value: "x" }, null, "");
        expect(result).toBeNull();
    });

    it("returns null for null input", () => {
        expect(renderObjectExpression(null, null, "")).toBeNull();
    });

    it("extracts string properties", () => {
        const parsed = parseObjectExpr(`({ url: "https://api.example.com", method: "GET" })`);
        expect(parsed).not.toBeNull();
        const result = renderObjectExpression(parsed!.node, parsed!.scope, parsed!.code);
        expect(result).toMatchObject({ url: "https://api.example.com", method: "GET" });
    });

    it("extracts numeric property as string", () => {
        const parsed = parseObjectExpr(`({ port: 8080 })`);
        expect(parsed).not.toBeNull();
        const result = renderObjectExpression(parsed!.node, parsed!.scope, parsed!.code);
        expect(result).toMatchObject({ port: "8080" });
    });

    it("handles StringLiteral keys", () => {
        const parsed = parseObjectExpr(`({ "Content-Type": "application/json" })`);
        expect(parsed).not.toBeNull();
        const result = renderObjectExpression(parsed!.node, parsed!.scope, parsed!.code);
        expect(result).toHaveProperty("Content-Type", "application/json");
    });

    it("returns empty object for ObjectExpression with no resolvable properties", () => {
        const parsed = parseObjectExpr(`({})`);
        expect(parsed).not.toBeNull();
        const result = renderObjectExpression(parsed!.node, parsed!.scope, parsed!.code);
        expect(result).toEqual({});
    });
});

describe("renderValueNode", () => {
    it("returns null for null node", () => {
        expect(renderValueNode(null, null, "")).toBeNull();
    });

    it("returns string for a StringLiteral node", () => {
        const parsed = parseValueExpr(`"hello"`);
        expect(parsed).not.toBeNull();
        const result = renderValueNode(parsed!.node, parsed!.scope, parsed!.code);
        expect(result).toBe("hello");
    });

    it("returns string for a NumericLiteral node", () => {
        const parsed = parseValueExpr(`42`);
        expect(parsed).not.toBeNull();
        const result = renderValueNode(parsed!.node, parsed!.scope, parsed!.code);
        expect(result).toBe("42");
    });

    it("returns null for an object node (non-scalar)", () => {
        const parsed = parseValueExpr(`({ key: "value" })`);
        expect(parsed).not.toBeNull();
        const result = renderValueNode(parsed!.node, parsed!.scope, parsed!.code);
        expect(result).toBeNull();
    });
});
