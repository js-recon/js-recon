import { describe, it, expect } from "vitest";
import * as parser from "@babel/parser";
import { extractChunkBuilderFunctions, resolveBuilderSource } from "../../lazyLoad/nuxt_js/nuxt_astParse.js";
import execFunc from "../../utility/runSandboxed.js";

describe("extractChunkBuilderFunctions", () => {
    it("finds a FunctionDeclaration ending with .js pattern", () => {
        const code = `function getChunkPath(e) { return "/_nuxt/" + e + ".js" }`;
        const result = extractChunkBuilderFunctions(code);
        expect(result.length).toBe(1);
        expect(result[0].type).toBe("FunctionDeclaration");
        expect(result[0].name).toBe("getChunkPath");
    });

    it("finds a FunctionExpression ending with .js pattern", () => {
        const code = `const u = function(e) { return f.p + e + ".js" }`;
        const result = extractChunkBuilderFunctions(code);
        expect(result.length).toBeGreaterThanOrEqual(1);
        expect(result.some((f) => f.type === "FunctionExpression")).toBe(true);
    });

    it("finds an ArrowFunctionExpression ending with .js pattern", () => {
        const code = `const u = (e) => "/" + e + ".js"`;
        const result = extractChunkBuilderFunctions(code);
        expect(result.length).toBeGreaterThanOrEqual(1);
        expect(result.some((f) => f.type === "ArrowFunctionExpression")).toBe(true);
    });

    it("does not include functions that do not end with .js pattern", () => {
        const code = `function noMatch(e) { return "/_nuxt/" + e + ".css" }`;
        const result = extractChunkBuilderFunctions(code);
        expect(result).toHaveLength(0);
    });

    it("returns [] for empty content", () => {
        expect(extractChunkBuilderFunctions("")).toEqual([]);
    });

    it("returns [] for invalid JS", () => {
        expect(extractChunkBuilderFunctions("{{{{ not valid %%%%")).toEqual([]);
    });

    it("includes the full function source in the result", () => {
        const code = `function getPath(e) { return "/_nuxt/chunks/" + e + ".js" }`;
        const result = extractChunkBuilderFunctions(code);
        expect(result[0].source).toContain("getPath");
        expect(result[0].source).toContain(".js");
    });

    it("finds multiple matching functions in one file", () => {
        const code = `
            function pathA(e) { return "/a/" + e + ".js" }
            const pathB = (e) => "/b/" + e + ".js"
        `;
        const result = extractChunkBuilderFunctions(code);
        expect(result.length).toBe(2);
    });
});

describe("resolveBuilderSource", () => {
    const parse = (code: string) => parser.parse(code, { sourceType: "module", errorRecovery: true });

    it("substitutes the public-path member with its assigned value", () => {
        const code = `f.p = "/_nuxt/"; var u = function(e) { return f.p + e + ".js" }`;
        const [builder] = extractChunkBuilderFunctions(code);
        const resolved = resolveBuilderSource(builder.source, parse(code));
        expect(execFunc(`(() => (${resolved}))()`, 3)).toBe("/_nuxt/3.js");
    });

    it("returns map-literal builders unchanged instead of crashing", () => {
        const code = `var u = function(t) { return ({1: "abc", 2: "def"})[t] + ".js" }`;
        const [builder] = extractChunkBuilderFunctions(code);
        const resolved = resolveBuilderSource(builder.source, parse(code));
        expect(resolved).toBe(builder.source);
        expect(execFunc(`(() => (${resolved}))()`, 2)).toBe("def.js");
    });
});
