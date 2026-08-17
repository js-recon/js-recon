import { describe, it, expect } from "vitest";
import * as parser from "@babel/parser";
import { extractStrings } from "../../strings/index.js";

const parse = (code: string) =>
    parser.parse(code, {
        sourceType: "module",
        plugins: ["jsx"],
        errorRecovery: true,
    });

describe("extractStrings", () => {
    it("extracts top-level string literals", () => {
        const ast = parse(`const a = "hello"; const b = "world";`);
        const result = extractStrings(ast);
        expect(result).toContain("hello");
        expect(result).toContain("world");
    });

    it("extracts strings from nested object", () => {
        const ast = parse(`const obj = { key: "value", nested: { deep: "deep-value" } };`);
        const result = extractStrings(ast);
        expect(result).toContain("value");
        expect(result).toContain("deep-value");
    });

    it("extracts cooked template literal parts", () => {
        const ast = parse("const x = `/api/v1/users`;");
        const result = extractStrings(ast);
        expect(result).toContain("/api/v1/users");
    });

    it("extracts strings from function arguments", () => {
        const ast = parse(`fetch("/api/endpoint", { method: "POST" });`);
        const result = extractStrings(ast);
        expect(result).toContain("/api/endpoint");
        expect(result).toContain("POST");
    });

    it("deduplicates repeated strings", () => {
        const ast = parse(`const a = "dup"; const b = "dup"; const c = "dup";`);
        const result = extractStrings(ast);
        expect(result.filter((s) => s === "dup").length).toBe(1);
    });

    it("returns empty array for code with no string literals", () => {
        const ast = parse(`const x = 42; const y = true;`);
        const result = extractStrings(ast);
        expect(result).toHaveLength(0);
    });

    it("extracts strings from array literals", () => {
        const ast = parse(`const arr = ["/path/one", "/path/two", "/path/three"];`);
        const result = extractStrings(ast);
        expect(result).toContain("/path/one");
        expect(result).toContain("/path/two");
        expect(result).toContain("/path/three");
    });

    it("handles template literal with expressions — extracts static quasis", () => {
        const ast = parse("const url = `/api/${version}/users`;");
        const result = extractStrings(ast);
        expect(result).toContain("/api/");
        expect(result).toContain("/users");
    });

    it("does not crash on empty program", () => {
        const ast = parse("");
        expect(() => extractStrings(ast)).not.toThrow();
    });
});
