import { describe, it, expect } from "vitest";
import { resolveChunkVarAsUrlPart } from "../../map/babel-legacy/next_js/utils.js";

describe("resolveChunkVarAsUrlPart", () => {
    it("returns a value containing / for a URL-shaped string", () => {
        const code = `const baseUrl = "https://api.example.com/v1";`;
        expect(resolveChunkVarAsUrlPart("baseUrl", code)).toBe("https://api.example.com/v1");
    });

    it("returns a value for a path-only string (contains /)", () => {
        const code = `const apiPath = "/api/users";`;
        expect(resolveChunkVarAsUrlPart("apiPath", code)).toBe("/api/users");
    });

    it("returns null when the resolved value has no / or ://", () => {
        const code = `const version = "v2";`;
        expect(resolveChunkVarAsUrlPart("version", code)).toBeNull();
    });

    it("returns null when the variable is unresolved", () => {
        const code = `function doSomething() {}`;
        expect(resolveChunkVarAsUrlPart("missing", code)).toBeNull();
    });

    it("returns null when the resolved value is a placeholder", () => {
        // a variable referencing another unresolved variable produces [unresolved: ...]
        const code = `const x = unknownVar;`;
        expect(resolveChunkVarAsUrlPart("x", code)).toBeNull();
    });

    it("returns a :// scheme URL", () => {
        const code = `const endpoint = "wss://realtime.example.com";`;
        expect(resolveChunkVarAsUrlPart("endpoint", code)).toBe("wss://realtime.example.com");
    });
});
