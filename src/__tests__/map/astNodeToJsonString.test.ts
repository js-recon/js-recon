import { describe, it, expect } from "vitest";
import * as parser from "@babel/parser";
import { astNodeToJsonString } from "../../map/next_js/resolveAxiosHelpers/astNodeToJsonString.js";

/** Parse a JS expression and return the initializer node (wraps in `const _x = ...`). */
function parseExpr(exprCode: string) {
    const code = `const _x = ${exprCode};`;
    const ast = parser.parse(code, { sourceType: "module", plugins: ["jsx", "typescript"] });
    const stmt = ast.program.body[0] as any;
    const node = stmt.declarations[0].init;
    return { node, code };
}

describe("astNodeToJsonString", () => {
    it("serializes a StringLiteral as a JSON-quoted string", () => {
        const { node, code } = parseExpr(`"hello world"`);
        expect(astNodeToJsonString(node, code)).toBe('"hello world"');
    });

    it("serializes a NumericLiteral as its numeric string", () => {
        const { node, code } = parseExpr(`42`);
        expect(astNodeToJsonString(node, code)).toBe("42");
    });

    it("serializes a BooleanLiteral", () => {
        const { node: t, code: c1 } = parseExpr(`true`);
        expect(astNodeToJsonString(t, c1)).toBe("true");

        const { node: f, code: c2 } = parseExpr(`false`);
        expect(astNodeToJsonString(f, c2)).toBe("false");
    });

    it("serializes NullLiteral as 'null'", () => {
        const { node, code } = parseExpr(`null`);
        expect(astNodeToJsonString(node, code)).toBe("null");
    });

    it("serializes an Identifier as a quoted name", () => {
        const { node, code } = parseExpr(`myVar`);
        expect(astNodeToJsonString(node, code)).toBe('"myVar"');
    });

    it("serializes an ObjectExpression", () => {
        const { node, code } = parseExpr(`({ key: "value", count: 1 })`);
        expect(astNodeToJsonString(node, code)).toBe('{"key": "value", "count": 1}');
    });

    it("serializes an ArrayExpression", () => {
        const { node, code } = parseExpr(`[1, "two", true]`);
        expect(astNodeToJsonString(node, code)).toBe('[1, "two", true]');
    });

    it("serializes a MemberExpression by slicing code", () => {
        const { node, code } = parseExpr(`obj.prop`);
        expect(astNodeToJsonString(node, code)).toBe('"obj.prop"');
    });

    it("returns '\"\"' for null node", () => {
        expect(astNodeToJsonString(null as any, "")).toBe('""');
    });

    it("skips SpreadElement inside ObjectExpression", () => {
        const { node, code } = parseExpr(`({ ...rest, key: "v" })`);
        const result = astNodeToJsonString(node, code);
        expect(result).toContain('"key": "v"');
        expect(result).not.toContain("rest");
    });
});
