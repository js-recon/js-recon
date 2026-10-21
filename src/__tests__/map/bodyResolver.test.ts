import { describe, it, expect } from "vitest";
import { mapLeafStrings, hasMarkers } from "../../map/babel-legacy/vue_js/bodyResolver.js";

describe("mapLeafStrings", () => {
    it("applies fn to a string value directly", () => {
        expect(mapLeafStrings("hello", (s) => s.toUpperCase())).toBe("HELLO");
    });

    it("applies fn to all strings in a flat array", () => {
        expect(mapLeafStrings(["a", "b", "c"], (s) => s + "!")).toEqual(["a!", "b!", "c!"]);
    });

    it("applies fn recursively to nested objects", () => {
        const obj = { key: "value", nested: { deep: "text" } };
        const result = mapLeafStrings(obj, (s) => s.toUpperCase());
        expect(result).toEqual({ key: "VALUE", nested: { deep: "TEXT" } });
    });

    it("applies fn recursively through mixed arrays and objects", () => {
        const val = { items: ["a", "b"], meta: { label: "test" } };
        const result = mapLeafStrings(val, (s) => `[${s}]`);
        expect(result).toEqual({ items: ["[a]", "[b]"], meta: { label: "[test]" } });
    });

    it("passes numbers through unchanged", () => {
        expect(mapLeafStrings(42, (s) => s.toUpperCase())).toBe(42);
    });

    it("returns null unchanged", () => {
        expect(mapLeafStrings(null, (s) => s.toUpperCase())).toBeNull();
    });

    it("returns undefined unchanged", () => {
        expect(mapLeafStrings(undefined, (s) => s.toUpperCase())).toBeUndefined();
    });

    it("handles empty object", () => {
        expect(mapLeafStrings({}, (s) => s)).toEqual({});
    });

    it("handles empty array", () => {
        expect(mapLeafStrings([], (s) => s)).toEqual([]);
    });
});

describe("hasMarkers", () => {
    it("returns false for plain string without markers", () => {
        expect(hasMarkers("/api/users")).toBe(false);
    });

    it("returns true for [param:X] marker string", () => {
        expect(hasMarkers("[param:userId]")).toBe(true);
    });

    it("returns true for [member:obj.prop] marker string", () => {
        expect(hasMarkers("[member:config.baseUrl]")).toBe(true);
    });

    it("returns true for [call:fn()] marker string", () => {
        expect(hasMarkers("[call:getUrl()]")).toBe(true);
    });

    it("returns true for [urlsearchparams:x] marker string", () => {
        expect(hasMarkers("[urlsearchparams:query.filter]")).toBe(true);
    });

    it("returns true when a nested object contains a marker", () => {
        const val = { url: "/api/[param:id]", method: "GET" };
        expect(hasMarkers(val)).toBe(true);
    });

    it("returns false when nested object has no markers", () => {
        const val = { url: "/api/users", method: "GET" };
        expect(hasMarkers(val)).toBe(false);
    });

    it("returns true when an array element is a marker", () => {
        expect(hasMarkers(["/api/items", "[param:filter]"])).toBe(true);
    });

    it("returns false for null", () => {
        expect(hasMarkers(null)).toBe(false);
    });

    it("returns false for undefined", () => {
        expect(hasMarkers(undefined)).toBe(false);
    });
});
