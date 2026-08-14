import { describe, it, expect } from "vitest";
// @ts-expect-error -- plain .mjs script helper, no type declarations
import { normalize, normalizeSet } from "../../../scripts/dev-server-benchmark-utils.mjs";

describe("normalize", () => {
    it("collapses duplicate slashes in the pathname", () => {
        expect(normalize("https://example.test//foo///bar.js")).toBe("https://example.test/foo/bar.js");
    });

    it("strips query strings and fragments via origin+pathname reconstruction", () => {
        expect(normalize("https://example.test/foo.js?v=1#frag")).toBe("https://example.test/foo.js");
    });

    it("trims surrounding whitespace before parsing", () => {
        expect(normalize("  https://example.test/foo.js  ")).toBe("https://example.test/foo.js");
    });

    it("returns null for a malformed URL", () => {
        expect(normalize("not a url")).toBeNull();
    });

    it("returns null for an empty string", () => {
        expect(normalize("")).toBeNull();
    });
});

describe("normalizeSet", () => {
    it("dedupes normalized URLs that differ only by query string", () => {
        const result = normalizeSet(["https://example.test/foo.js?a=1", "https://example.test/foo.js?a=2"]);
        expect(result).toEqual(new Set(["https://example.test/foo.js"]));
    });

    it("drops malformed entries instead of throwing", () => {
        const result = normalizeSet(["https://example.test/foo.js", "not a url", ""]);
        expect(result).toEqual(new Set(["https://example.test/foo.js"]));
    });

    it("returns an empty set for an empty input array", () => {
        expect(normalizeSet([])).toEqual(new Set());
    });
});
