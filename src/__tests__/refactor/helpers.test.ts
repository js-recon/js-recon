import { describe, it, expect } from "vitest";
import * as parser from "@babel/parser";
import traverse from "@babel/traverse";
import * as t from "@babel/types";
import generate from "@babel/generator";
import { NodePath } from "@babel/traverse";
import {
    isInModuleMap,
    tryExtractRequireCall,
    tryExtractExportsAssignment,
    tryExtractModuleExportsAssignment,
    buildModuleExportStatement,
    makeNamedExportStatement,
} from "../../refactor/react/helpers.js";

function captureAllObjectPropertyPaths(code: string): NodePath[] {
    const ast = parser.parse(code, { sourceType: "unambiguous" });
    const paths: NodePath[] = [];
    traverse(ast, {
        ObjectProperty(p) {
            paths.push(p);
        },
    });
    return paths;
}

// ── isInModuleMap ──────────────────────────────────────────────────────────────

describe("isInModuleMap", () => {
    it("returns true for a property inside a var-declarator object", () => {
        const [p] = captureAllObjectPropertyPaths("var e = { 123: function(m,e,t){} }");
        expect(isInModuleMap(p)).toBe(true);
    });

    it("returns true for a property inside an assignment-expression object", () => {
        const [p] = captureAllObjectPropertyPaths("e = { 123: function(m,e,t){} }");
        expect(isInModuleMap(p)).toBe(true);
    });

    it("returns true for a property in the lazy-chunk .push() pattern", () => {
        const paths = captureAllObjectPropertyPaths("webpackChunk.push([[0], { 123: function(m,e,t){} }])");
        const p = paths.find((_p) => t.isNumericLiteral((_p.node as t.ObjectProperty).key, { value: 123 }))!;
        expect(isInModuleMap(p)).toBe(true);
    });

    it("returns false for a property inside a function-call argument object", () => {
        const [p] = captureAllObjectPropertyPaths("foo({ inner: 1 })");
        expect(isInModuleMap(p)).toBe(false);
    });

    it("returns false for a nested object property (not direct child of module-map holder)", () => {
        const paths = captureAllObjectPropertyPaths("var e = { outer: { inner: 1 } }");
        const innerProp = paths.find((_p) => t.isIdentifier((_p.node as t.ObjectProperty).key, { name: "inner" }))!;
        expect(isInModuleMap(innerProp)).toBe(false);
    });
});

// ── tryExtractRequireCall ──────────────────────────────────────────────────────

describe("tryExtractRequireCall", () => {
    it("returns module id for a matching require call", () => {
        const expr = t.callExpression(t.identifier("t"), [t.numericLiteral(123)]);
        expect(tryExtractRequireCall(expr, "t")).toBe(123);
    });

    it("returns null when callee name does not match requireParam", () => {
        const expr = t.callExpression(t.identifier("r"), [t.numericLiteral(123)]);
        expect(tryExtractRequireCall(expr, "t")).toBeNull();
    });

    it("returns null when argument is not a numeric literal", () => {
        const expr = t.callExpression(t.identifier("t"), [t.stringLiteral("foo")]);
        expect(tryExtractRequireCall(expr, "t")).toBeNull();
    });

    it("returns null when there are no arguments", () => {
        const expr = t.callExpression(t.identifier("t"), []);
        expect(tryExtractRequireCall(expr, "t")).toBeNull();
    });

    it("returns null for a non-call-expression node", () => {
        expect(tryExtractRequireCall(t.numericLiteral(42), "t")).toBeNull();
    });
});

// ── tryExtractExportsAssignment ───────────────────────────────────────────────

describe("tryExtractExportsAssignment", () => {
    it("extracts propName and rhs from e.foo = bar", () => {
        const expr = t.assignmentExpression(
            "=",
            t.memberExpression(t.identifier("e"), t.identifier("foo")),
            t.identifier("bar")
        );
        const result = tryExtractExportsAssignment(expr, "e");
        expect(result).not.toBeNull();
        expect(result!.propName).toBe("foo");
    });

    it("returns null when object name does not match exportsParam", () => {
        const expr = t.assignmentExpression(
            "=",
            t.memberExpression(t.identifier("n"), t.identifier("foo")),
            t.identifier("bar")
        );
        expect(tryExtractExportsAssignment(expr, "e")).toBeNull();
    });

    it("returns null for a non-assignment expression", () => {
        expect(tryExtractExportsAssignment(t.numericLiteral(1), "e")).toBeNull();
    });

    it("returns null for a non-= operator (+=)", () => {
        const expr = t.assignmentExpression(
            "+=",
            t.memberExpression(t.identifier("e"), t.identifier("foo")),
            t.numericLiteral(1)
        );
        expect(tryExtractExportsAssignment(expr, "e")).toBeNull();
    });

    it("returns null for a computed member expression (e['key'])", () => {
        const expr = t.assignmentExpression(
            "=",
            t.memberExpression(t.identifier("e"), t.stringLiteral("key"), true),
            t.numericLiteral(1)
        );
        expect(tryExtractExportsAssignment(expr, "e")).toBeNull();
    });
});

// ── tryExtractModuleExportsAssignment ─────────────────────────────────────────

describe("tryExtractModuleExportsAssignment", () => {
    it("returns rhs for e.exports = rhs", () => {
        const rhs = t.objectExpression([]);
        const expr = t.assignmentExpression("=", t.memberExpression(t.identifier("e"), t.identifier("exports")), rhs);
        expect(tryExtractModuleExportsAssignment(expr, "e")).toBe(rhs);
    });

    it("returns null when property is not 'exports'", () => {
        const expr = t.assignmentExpression(
            "=",
            t.memberExpression(t.identifier("e"), t.identifier("default")),
            t.numericLiteral(1)
        );
        expect(tryExtractModuleExportsAssignment(expr, "e")).toBeNull();
    });

    it("returns null when object name does not match moduleParam", () => {
        const expr = t.assignmentExpression(
            "=",
            t.memberExpression(t.identifier("m"), t.identifier("exports")),
            t.numericLiteral(1)
        );
        expect(tryExtractModuleExportsAssignment(expr, "e")).toBeNull();
    });

    it("returns null for a non-assignment node", () => {
        expect(tryExtractModuleExportsAssignment(t.identifier("e"), "e")).toBeNull();
    });
});

// ── buildModuleExportStatement ────────────────────────────────────────────────

describe("buildModuleExportStatement", () => {
    it("emits 'export * from' when rhs is a require call matching requireParam", () => {
        const rhs = t.callExpression(t.identifier("t"), [t.numericLiteral(42)]);
        const stmt = buildModuleExportStatement(rhs, "t");
        expect(t.isExportAllDeclaration(stmt)).toBe(true);
        expect(generate(stmt as any).code).toContain("./42.js");
    });

    it("emits 'export default' when rhs is not a require call", () => {
        const rhs = t.objectExpression([]);
        const stmt = buildModuleExportStatement(rhs, "t");
        expect(t.isExportDefaultDeclaration(stmt)).toBe(true);
    });

    it("emits 'export default' when requireParam is undefined", () => {
        const rhs = t.callExpression(t.identifier("t"), [t.numericLiteral(42)]);
        const stmt = buildModuleExportStatement(rhs, undefined);
        expect(t.isExportDefaultDeclaration(stmt)).toBe(true);
    });
});

// ── makeNamedExportStatement ──────────────────────────────────────────────────

describe("makeNamedExportStatement", () => {
    it("produces 'export function' for a FunctionExpression rhs", () => {
        const fn = t.functionExpression(null, [], t.blockStatement([]));
        const stmt = makeNamedExportStatement("foo", fn);
        expect(generate(stmt as any).code).toContain("export function foo");
    });

    it("produces 'export { rhs as name }' for an Identifier rhs", () => {
        const stmt = makeNamedExportStatement("foo", t.identifier("bar"));
        const code = generate(stmt as any).code;
        expect(code).toContain("bar");
        expect(code).toContain("foo");
    });

    it("produces 'export const name = value' for a numeric literal rhs", () => {
        const stmt = makeNamedExportStatement("foo", t.numericLiteral(42));
        expect(generate(stmt as any).code).toContain("export const foo = 42");
    });

    it("uses a string exported key for prop names that are not valid JS identifiers", () => {
        const stmt = makeNamedExportStatement("prop-name", t.identifier("x"));
        const code = generate(stmt as any).code;
        expect(code).toContain('"prop-name"');
    });

    it("uses an identifier exported key for valid JS identifier prop names", () => {
        const stmt = makeNamedExportStatement("validName", t.identifier("x")) as t.ExportNamedDeclaration;
        expect(stmt.specifiers.length).toBeGreaterThan(0);
        expect(t.isIdentifier((stmt.specifiers[0] as t.ExportSpecifier).exported)).toBe(true);
    });
});
