import { describe, it, expect } from "vitest";
import {
    resolveVariableInChunk,
    resolveStringOps,
    substituteVariablesInString,
} from "../../map/babel-legacy/next_js/utils.js";

describe("resolveVariableInChunk", () => {
    it("resolves a simple const string declaration", () => {
        const code = `const baseUrl = "/api/v1";`;
        expect(resolveVariableInChunk("baseUrl", code)).toBe("/api/v1");
    });

    it("resolves a const number declaration (returns as string)", () => {
        const code = `const timeout = 3000;`;
        // resolveVariableInChunk returns string representations of numeric literals
        expect(resolveVariableInChunk("timeout", code)).toBe("3000");
    });

    it("returns unresolved placeholder for unknown variable", () => {
        const code = `const x = 1;`;
        const result = resolveVariableInChunk("unknownVar", code);
        expect(typeof result).toBe("string");
        expect(result).toContain("[unresolved:");
    });

    it("returns unresolved placeholder for undeclared variable", () => {
        const code = `console.log("hello");`;
        const result = resolveVariableInChunk("myVar", code);
        expect(result).toContain("[unresolved:");
    });

    it("handles max recursion depth gracefully", () => {
        const code = `const x = "value";`;
        const result = resolveVariableInChunk("x", code, 6);
        expect(result).toContain("[max recursion depth");
    });

    it("resolves a string declared with let", () => {
        const code = `let apiPath = "/users";`;
        expect(resolveVariableInChunk("apiPath", code)).toBe("/users");
    });

    it("returns unresolved placeholder for boolean const (not supported literal type)", () => {
        const code = `const debug = true;`;
        // BooleanLiteral is not handled by the resolver — returns unresolved placeholder
        const result = resolveVariableInChunk("debug", code);
        expect(typeof result).toBe("string");
        expect(result).toContain("[unresolved:");
    });
});

describe("resolveStringOps", () => {
    it("returns input unchanged when no concat pattern", () => {
        expect(resolveStringOps("/api/v1")).toBe("/api/v1");
    });

    it("returns empty string unchanged", () => {
        expect(resolveStringOps("")).toBe("");
    });

    it("flattens string.concat with a literal argument", () => {
        const result = resolveStringOps(`"/api/".concat("users")`);
        expect(result).toBe("/api/users");
    });

    it("flattens string.concat with multiple literal arguments", () => {
        const result = resolveStringOps(`"/api/".concat("v1", "/users")`);
        expect(result).toBe("/api/v1/users");
    });
});

describe("substituteVariablesInString", () => {
    it("substitutes [var name] with resolved value from chunk", () => {
        const code = `const prefix = "api";`;
        const result = substituteVariablesInString("/[var prefix]/users", code);
        expect(result).toBe("/api/users");
    });

    it("leaves [var name] unchanged when variable cannot be resolved", () => {
        const code = `const x = 1;`;
        const result = substituteVariablesInString("/[var unknownPath]/users", code);
        expect(result).toContain("[var unknownPath]");
    });

    it("returns string unchanged when no placeholders present", () => {
        const code = `const x = "hello";`;
        expect(substituteVariablesInString("/api/users", code)).toBe("/api/users");
    });

    it("does not substitute [var name] when resolved value is a pure number", () => {
        const code = `const count = 42;`;
        const result = substituteVariablesInString("/items/[var count]", code);
        expect(result).toContain("[var count]");
    });
});
