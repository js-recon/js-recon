import { describe, it, expect } from "vitest";
import parser from "@babel/parser";
import _traverse from "@babel/traverse";
import { findMemberExpressionAssignment } from "../../analyze/helpers/engineHelpers/findMemberExpressionAssignment.js";

const traverse = (_traverse as any).default ?? _traverse;

function parseHandlerFunction(code: string) {
    const src = `const _x = ${code};`;
    const ast = parser.parse(src, { sourceType: "unambiguous" });
    let node: any;
    traverse(ast, {
        VariableDeclarator(p: any) {
            node = p.node.init;
            p.stop();
        },
    });
    return node;
}

describe("findMemberExpressionAssignment", () => {
    it("finds an assignment nested inside an if block without throwing", () => {
        const fn = parseHandlerFunction(`function (e) {
            if (e.origin.endsWith(".trusted.example.com")) {
                const target = document.getElementById("some-target");
                if (target) {
                    target.textContent = e.data.value;
                }
            }
        }`);

        expect(() => findMemberExpressionAssignment(fn, "textContent")).not.toThrow();
        const result = findMemberExpressionAssignment(fn, "textContent");
        expect(result).toBeDefined();
        expect((result as any).type).toBe("AssignmentExpression");
        expect((result as any).left.property.name).toBe("textContent");
    });

    it("finds a top-level (non-nested) member expression assignment", () => {
        const fn = parseHandlerFunction(`function (e) {
            target.textContent = e.data.value;
        }`);

        const result = findMemberExpressionAssignment(fn, "textContent");
        expect(result).toBeDefined();
        expect((result as any).left.property.name).toBe("textContent");
    });

    it("still finds the assignment for the && short-circuit shape", () => {
        const fn = parseHandlerFunction(`function (e) {
            originOk && target && (target.textContent = e.data.value);
        }`);

        const result = findMemberExpressionAssignment(fn, "textContent");
        expect(result).toBeDefined();
        expect((result as any).left.property.name).toBe("textContent");
    });

    it("returns undefined when no matching assignment exists", () => {
        const fn = parseHandlerFunction(`function (e) {
            target.innerHTML = e.data.value;
        }`);

        const result = findMemberExpressionAssignment(fn, "textContent");
        expect(result).toBeUndefined();
    });
});
