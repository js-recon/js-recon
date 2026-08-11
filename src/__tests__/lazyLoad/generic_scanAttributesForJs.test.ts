import { describe, it, expect } from "vitest";
import {
    findJsPathSegmentCandidates,
    resolveJsPathCandidate,
} from "../../lazyLoad/generic/generic_scanAttributesForJs.js";

describe("findJsPathSegmentCandidates", () => {
    it("finds a normal trailing .js URL", () => {
        const html = `<a href="/a/b.js">link</a>`;
        const result = findJsPathSegmentCandidates(html, "https://example.com");
        expect(result).toEqual(["https://example.com/a/b.js"]);
    });

    it("finds a .js path segment that is not the final segment (cachebuster shape)", () => {
        const html = `<script data-src="/beacon.min.js/v124/token"></script>`;
        const result = findJsPathSegmentCandidates(html, "https://example.com");
        expect(result).toEqual(["https://example.com/beacon.min.js/v124/token"]);
    });

    it("ignores URLs with no .js anywhere in the path", () => {
        const html = `<img src="/images/logo.png"><a href="/about">About</a>`;
        const result = findJsPathSegmentCandidates(html, "https://example.com");
        expect(result).toEqual([]);
    });

    it("does not throw on unparseable attribute values and excludes them", () => {
        const html = `<div data-foo="not a url at all :::">test</div>`;
        expect(() => findJsPathSegmentCandidates(html, "https://example.com")).not.toThrow();
        expect(findJsPathSegmentCandidates(html, "https://example.com")).toEqual([]);
    });

    it("dedupes repeated candidates", () => {
        const html = `<a href="/a.js">one</a><a href="/a.js">two</a>`;
        const result = findJsPathSegmentCandidates(html, "https://example.com");
        expect(result).toEqual(["https://example.com/a.js"]);
    });

    it("is case-insensitive on the .js suffix", () => {
        const html = `<a href="/a/B.JS">link</a>`;
        const result = findJsPathSegmentCandidates(html, "https://example.com");
        expect(result).toEqual(["https://example.com/a/B.JS"]);
    });

    it("ignores non-http(s) schemes even when the pathname ends in .js (e.g. blob:)", () => {
        const html = `<script data-src="blob:https://example.com/some-uuid.js"></script>`;
        const result = findJsPathSegmentCandidates(html, "https://example.com");
        expect(result).toEqual([]);
    });
});

describe("resolveJsPathCandidate", () => {
    it("ignores a fragment-only value that would inherit a .js base's pathname unchanged", () => {
        // Regression: a CSS selector string embedded in a Vue bundle's scoped styles
        // (e.g. found inside main.js by generic_stringsDiscovery.ts) resolved against
        // main.js's own URL would otherwise falsely look like a distinct JS candidate,
        // purely because it inherited the base's own ".js"-ending pathname.
        const result = resolveJsPathCandidate("#aw--c .banner{color:red}", "https://example.com/v5/aw-bundle.js");
        expect(result).toBeNull();
    });

    it("ignores a query-only value for the same reason", () => {
        const result = resolveJsPathCandidate("?foo=bar", "https://example.com/v5/aw-bundle.js");
        expect(result).toBeNull();
    });

    it("still resolves a real relative path against a .js base", () => {
        const result = resolveJsPathCandidate("../other.js", "https://example.com/v5/aw-bundle.js");
        expect(result).toBe("https://example.com/other.js");
    });

    it("still resolves an absolute path against a .js base", () => {
        const result = resolveJsPathCandidate("/assets/pdf.worker.js", "https://example.com/v5/aw-bundle.js");
        expect(result).toBe("https://example.com/assets/pdf.worker.js");
    });

    it("returns null for an empty or whitespace-only value", () => {
        expect(resolveJsPathCandidate("", "https://example.com")).toBeNull();
        expect(resolveJsPathCandidate("   ", "https://example.com")).toBeNull();
    });
});
