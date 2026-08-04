import { describe, it, expect } from "vitest";
import {
    extractObjectMapChunkEntries,
    extractIfChainChunkFilenames,
    extractExpressionBodyChunkFilenames,
    extractWebpackChunkUrls,
} from "../../../lazyLoad/shared/webpackChunkParsers.js";
import { deduplicateWebpackChunkPaths } from "../../../lazyLoad/react/react_webpackChunkPaths.js";

describe("deduplicateWebpackChunkPaths", () => {
    it("returns the exact unique URLs whose count is shown and queued", () => {
        expect(
            deduplicateWebpackChunkPaths([
                "https://example.test/chunk-a.js",
                "https://example.test/chunk-a.js",
                "https://example.test/chunk-b.js",
            ])
        ).toEqual(["https://example.test/chunk-a.js", "https://example.test/chunk-b.js"]);
    });
});

describe("extractObjectMapChunkEntries", () => {
    it("extracts numeric-keyed string entries from a FunctionExpression object map", () => {
        const code = `
            r.u = function(e) {
                return ({123: "page-home", 456: "page-about", 789: "page-settings"}[e] || e) + ".js";
            }
        `;
        const result = extractObjectMapChunkEntries(code);
        expect(result.length).toBe(3);
        expect(result).toContainEqual([123, "page-home"]);
        expect(result).toContainEqual([456, "page-about"]);
        expect(result).toContainEqual([789, "page-settings"]);
    });

    it("handles string-keyed numeric identifiers", () => {
        const code = `
            r.u = function(e) {
                return ({"100": "chunk-a", "200": "chunk-b", "300": "chunk-c"}[e] || e) + ".js";
            }
        `;
        const result = extractObjectMapChunkEntries(code);
        expect(result.length).toBe(3);
        expect(result).toContainEqual([100, "chunk-a"]);
    });

    it("skips object maps with fewer than 3 entries", () => {
        const code = `
            r.u = function(e) {
                return ({1: "only", 2: "two"}[e] || e) + ".js";
            }
        `;
        // Only 2 entries — below the threshold
        const result = extractObjectMapChunkEntries(code);
        expect(result).toHaveLength(0);
    });

    it("returns [] when no matching FunctionExpression", () => {
        const code = `const x = (e) => e + ".js";`;
        expect(extractObjectMapChunkEntries(code)).toEqual([]);
    });

    it("returns [] for empty content", () => {
        expect(extractObjectMapChunkEntries("")).toEqual([]);
    });

    it("returns [] for invalid JS", () => {
        expect(extractObjectMapChunkEntries("{{{{ not valid %%%%")).toEqual([]);
    });
});

describe("extractIfChainChunkFilenames", () => {
    it("extracts filenames from an if-chain pattern", () => {
        const code = `
            r.u = (e) => {
                if (123 === e) return "page-home.abc.js";
                if (456 === e) return "page-about.def.js";
                if (789 === e) return "page-settings.ghi.js";
            }
        `;
        const result = extractIfChainChunkFilenames(code);
        expect(result).toContain("page-home.abc.js");
        expect(result).toContain("page-about.def.js");
        expect(result).toContain("page-settings.ghi.js");
    });

    it("also accepts (e === N) comparison order", () => {
        const code = `
            r.u = (e) => {
                if (e === 1) return "a.js";
                if (e === 2) return "b.js";
                if (e === 3) return "c.js";
            }
        `;
        const result = extractIfChainChunkFilenames(code);
        expect(result.length).toBe(3);
    });

    it("skips if-chains with fewer than 3 .js filenames", () => {
        const code = `
            r.u = (e) => {
                if (1 === e) return "a.js";
                if (2 === e) return "b.js";
            }
        `;
        expect(extractIfChainChunkFilenames(code)).toHaveLength(0);
    });

    it("does not match expression-body arrows ending with .js", () => {
        const code = `r.u = (e) => "/" + e + ".js"`;
        expect(extractIfChainChunkFilenames(code)).toHaveLength(0);
    });

    it("returns [] for empty content", () => {
        expect(extractIfChainChunkFilenames("")).toEqual([]);
    });

    it("returns [] for invalid JS", () => {
        expect(extractIfChainChunkFilenames("{{{{ not valid %%%%")).toEqual([]);
    });
});

describe("extractExpressionBodyChunkFilenames", () => {
    it("executes an expression-body arrow's hash-map lookup for every referenced integer", () => {
        const code = `r.u = (e) => ({123: "page-home", 456: "page-about"}[e] || e) + ".js"`;
        const result = extractExpressionBodyChunkFilenames(code);
        expect(result).toContain("page-home.js");
        expect(result).toContain("page-about.js");
    });

    it("returns [] when no integers are referenced", () => {
        const code = `r.u = (e) => e + ".js"`;
        expect(extractExpressionBodyChunkFilenames(code)).toEqual([]);
    });

    it("returns [] for empty content", () => {
        expect(extractExpressionBodyChunkFilenames("")).toEqual([]);
    });

    it("returns [] for invalid JS", () => {
        expect(extractExpressionBodyChunkFilenames("{{{{ not valid %%%%")).toEqual([]);
    });
});

describe("extractWebpackChunkUrls", () => {
    it("resolves object-map chunk names one directory up from the entry chunk", () => {
        const code = `
            r.u = function(e) {
                return ({123: "page-home", 456: "page-about", 789: "page-settings"}[e] || e) + ".js";
            }
        `;
        const urls = extractWebpackChunkUrls(code, "https://example.com/assets/entry.js");
        expect(urls).toContain("https://example.com/page-home.js");
        expect(urls).toContain("https://example.com/page-about.js");
        expect(urls).toContain("https://example.com/page-settings.js");
    });

    it("resolves if-chain filenames the same way", () => {
        const code = `
            r.u = (e) => {
                if (123 === e) return "page-home.abc.js";
                if (456 === e) return "page-about.def.js";
                if (789 === e) return "page-settings.ghi.js";
            }
        `;
        const urls = extractWebpackChunkUrls(code, "https://example.com/assets/entry.js");
        expect(urls).toContain("https://example.com/page-home.abc.js");
    });

    it("resolves an absolute-path filename as-is instead of prefixing '../'", () => {
        const code = `
            r.u = (e) => {
                if (1 === e) return "/static/a.js";
                if (2 === e) return "/static/b.js";
                if (3 === e) return "/static/c.js";
            }
        `;
        const urls = extractWebpackChunkUrls(code, "https://example.com/assets/entry.js");
        expect(urls).toContain("https://example.com/static/a.js");
    });

    it("returns [] for content with no matching patterns", () => {
        expect(extractWebpackChunkUrls("const x = 1;", "https://example.com/entry.js")).toEqual([]);
    });
});
