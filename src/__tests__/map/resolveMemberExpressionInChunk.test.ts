import { describe, it, expect } from "vitest";
import { resolveMemberExpressionInChunk } from "../../map/babel-legacy/next_js/utils.js";

describe("resolveMemberExpressionInChunk", () => {
    it("resolves a string property from an object literal", () => {
        const code = `const config = { baseUrl: "https://api.example.com" };`;
        expect(resolveMemberExpressionInChunk("config", "baseUrl", code)).toBe("https://api.example.com");
    });

    it("resolves a numeric property (returns as string)", () => {
        const code = `const opts = { port: 3000 };`;
        expect(resolveMemberExpressionInChunk("opts", "port", code)).toBe("3000");
    });

    it("resolves a template literal property", () => {
        const code = `const prefix = "v1"; const api = { path: \`/api/\${prefix}/users\` };`;
        expect(resolveMemberExpressionInChunk("api", "path", code)).toBe("/api/v1/users");
    });

    it("returns unresolved placeholder when property not found", () => {
        const code = `const config = { name: "test" };`;
        const result = resolveMemberExpressionInChunk("config", "missing", code);
        expect(result).toContain("[unresolved:");
    });

    it("returns unresolved placeholder when object not found", () => {
        const code = `const other = {};`;
        const result = resolveMemberExpressionInChunk("config", "baseUrl", code);
        expect(result).toContain("[unresolved:");
    });

    it("resolves indirect object via alias", () => {
        const code = `const base = { url: "/api" }; const alias = base;`;
        expect(resolveMemberExpressionInChunk("alias", "url", code)).toBe("/api");
    });

    it("resolves logical-or fallback value", () => {
        const code = `const env = {}; const cfg = { endpoint: env.API || "https://default.example.com" };`;
        const result = resolveMemberExpressionInChunk("cfg", "endpoint", code);
        expect(result).toBe("https://default.example.com");
    });

    it("respects depth limit and returns placeholder at max recursion", () => {
        const code = `const a = { x: "val" };`;
        const result = resolveMemberExpressionInChunk("a", "x", code, undefined, undefined, 11);
        expect(result).toContain("[max recursion depth");
    });
});
