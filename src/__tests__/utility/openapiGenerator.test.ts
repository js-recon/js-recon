import { describe, it, expect } from "vitest";
import { getZodPlaceholderType, getOpenApiType, generateOpenapiV3Spec } from "../../utility/openapiGenerator.js";
import type { OpenapiOutputItem } from "../../utility/globals.js";

describe("getZodPlaceholderType", () => {
    it("returns string for <string>", () => {
        expect(getZodPlaceholderType("<string>")).toBe("string");
    });

    it("returns number for <number>", () => {
        expect(getZodPlaceholderType("<number>")).toBe("number");
    });

    it("returns boolean for <boolean>", () => {
        expect(getZodPlaceholderType("<boolean>")).toBe("boolean");
    });

    it("returns array for <array>", () => {
        expect(getZodPlaceholderType("<array>")).toBe("array");
    });

    it("returns object for <object>", () => {
        expect(getZodPlaceholderType("<object>")).toBe("object");
    });

    it("returns null for non-placeholder string", () => {
        expect(getZodPlaceholderType("hello")).toBeNull();
    });

    it("returns null for non-string input", () => {
        expect(getZodPlaceholderType(42)).toBeNull();
        expect(getZodPlaceholderType(null)).toBeNull();
        expect(getZodPlaceholderType({})).toBeNull();
    });

    it("returns null for partial placeholder (no closing bracket)", () => {
        expect(getZodPlaceholderType("<string")).toBeNull();
    });
});

describe("getOpenApiType", () => {
    it("returns string for string value", () => {
        expect(getOpenApiType("hello")).toBe("string");
    });

    it("returns number for number value", () => {
        expect(getOpenApiType(42)).toBe("number");
    });

    it("returns boolean for boolean value", () => {
        expect(getOpenApiType(true)).toBe("boolean");
    });

    it("returns object for plain object", () => {
        expect(getOpenApiType({})).toBe("object");
    });

    it("returns array for array value", () => {
        expect(getOpenApiType([])).toBe("array");
    });

    it("returns string for null (OpenAPI 3.0 has no null type)", () => {
        expect(getOpenApiType(null)).toBe("string");
    });

    it("uses Zod placeholder type for <number>", () => {
        expect(getOpenApiType("<number>")).toBe("number");
    });

    it("uses Zod placeholder type for <boolean>", () => {
        expect(getOpenApiType("<boolean>")).toBe("boolean");
    });

    it("returns string for <unknown> placeholder (fallback in map)", () => {
        expect(getOpenApiType("<unknown>")).toBe("string");
    });
});

const makeItem = (overrides: Partial<OpenapiOutputItem>): OpenapiOutputItem => ({
    url: "https://example.com/api/test",
    path: "/api/test",
    method: "GET",
    chunkId: "chunk1",
    headers: {},
    body: null,
    ...overrides,
});

describe("generateOpenapiV3Spec", () => {
    it("returns a valid OpenAPI 3.0 spec skeleton when no items provided", () => {
        const spec = generateOpenapiV3Spec([], {});
        expect(spec.openapi).toBe("3.0.0");
        expect(spec.paths).toEqual({});
    });

    it("adds a path entry for a single item", () => {
        const items = [makeItem({ path: "/api/users", method: "GET" })];
        const spec = generateOpenapiV3Spec(items, {});
        expect(spec.paths["/api/users"]).toBeDefined();
        expect(spec.paths["/api/users"]["get"]).toBeDefined();
    });

    it("normalises method to lowercase", () => {
        const items = [makeItem({ path: "/api/create", method: "POST" })];
        const spec = generateOpenapiV3Spec(items, {});
        expect(spec.paths["/api/create"]["post"]).toBeDefined();
    });

    it("prepends a leading slash to paths that lack one", () => {
        const items = [makeItem({ path: "api/no-slash", method: "GET" })];
        const spec = generateOpenapiV3Spec(items, {});
        expect(spec.paths["/api/no-slash"]).toBeDefined();
    });

    it("strips absolute URL and keeps only pathname", () => {
        const items = [makeItem({ path: "https://example.com/api/data", method: "GET" })];
        const spec = generateOpenapiV3Spec(items, {});
        expect(spec.paths["/api/data"]).toBeDefined();
    });

    it("keeps path placeholders of absolute URLs as path params", () => {
        const items = [makeItem({ path: "https://example.com/api/[var id]/posts", method: "GET" })];
        const spec = generateOpenapiV3Spec(items, {});
        expect(spec.paths["/api/{id}/posts"]["get"].parameters).toContainEqual(
            expect.objectContaining({ name: "id", in: "path" })
        );
    });

    it("deduplicates identical (path, method) with fragment suffix", () => {
        const items = [
            makeItem({ path: "/api/users", method: "GET" }),
            makeItem({ path: "/api/users", method: "GET" }),
        ];
        const spec = generateOpenapiV3Spec(items, {});
        expect(spec.paths["/api/users"]).toBeDefined();
        expect(spec.paths["/api/users#2"]).toBeDefined();
    });

    it("replaces placeholder tokens in path using replacePlaceholders", () => {
        const items = [makeItem({ path: "/api/[var userId]/profile", method: "GET" })];
        const spec = generateOpenapiV3Spec(items, {});
        expect(spec.paths["/api/{userId}/profile"]).toBeDefined();
    });

    it("falls back to GET for unknown method string", () => {
        const items = [makeItem({ path: "/api/weird", method: "PROPFIND" })];
        const spec = generateOpenapiV3Spec(items, {});
        expect(spec.paths["/api/weird"]["get"]).toBeDefined();
    });

    it("includes tags when collectionFolder is set on item", () => {
        const items = [
            { ...makeItem({ path: "/graphql", method: "POST" }), collectionFolder: "GraphQL" } as OpenapiOutputItem,
        ];
        const spec = generateOpenapiV3Spec(items, {});
        expect(spec.paths["/graphql"]["post"].tags).toContain("GraphQL");
    });
});
