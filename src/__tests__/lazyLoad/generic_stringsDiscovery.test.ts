import { describe, it, expect } from "vitest";
import {
    extractFileSourceUrl,
    findJsPathCandidatesFromStrings,
} from "../../lazyLoad/generic/generic_stringsDiscovery.js";

describe("extractFileSourceUrl", () => {
    it("extracts the URL from a plain external-file header", () => {
        const content = "// File Source: https://example.com/main.js\nconsole.log(1);";
        expect(extractFileSourceUrl(content)).toBe("https://example.com/main.js");
    });

    it("extracts the URL from an inline-script header with a trailing suffix", () => {
        const content = "// File Source: https://example.com/page/ (inline script #0)\nvar x = 1;";
        expect(extractFileSourceUrl(content)).toBe("https://example.com/page/");
    });

    it("extracts the URL from a data-URI-script header", () => {
        const content = "// File Source: https://example.com/page/ (data URI script #2)\nvar y = 2;";
        expect(extractFileSourceUrl(content)).toBe("https://example.com/page/");
    });

    it("returns null when the file has no File Source header", () => {
        expect(extractFileSourceUrl("console.log('no header');")).toBeNull();
    });

    it("returns null for an empty file", () => {
        expect(extractFileSourceUrl("")).toBeNull();
    });
});

describe("findJsPathCandidatesFromStrings", () => {
    it("resolves a string literal against its own file's source URL", () => {
        const allStrings = {
            "/tmp/output/example.com/main.js": ["/assets/pdf.worker.js"],
        };
        const readFile = () => "// File Source: https://example.com/plugins/main.js\n...";
        const result = findJsPathCandidatesFromStrings(allStrings, readFile);
        expect(result).toEqual(["https://example.com/assets/pdf.worker.js"]);
    });

    it("finds a JS path that the strings module extracted from a nested string literal", () => {
        // Mirrors the Cloudflare challenge-platform case: `d.innerHTML="...;a.src='/cdn-cgi/.../main.js';..."`
        // nests a single-quoted path inside a larger double-quoted string. A regex scan of
        // the raw text can't safely split on the inner quotes, but Babel's AST walk (what
        // the `strings` module already does) extracts each StringLiteral individually
        // regardless of nesting depth — so by the time this function sees the array, the
        // nested path is already its own entry, same as any other string.
        const allStrings = {
            "/tmp/output/example.com/inline-0.js": [
                "abc",
                "def",
                "script",
                "/cdn-cgi/challenge-platform/scripts/jsd/main.js",
            ],
        };
        const readFile = () => "// File Source: https://example.com/ (inline script #0)\n...";
        const result = findJsPathCandidatesFromStrings(allStrings, readFile);
        expect(result).toEqual(["https://example.com/cdn-cgi/challenge-platform/scripts/jsd/main.js"]);
    });

    it("skips files that have no source URL header", () => {
        const allStrings = {
            "/tmp/output/example.com/orphan.js": ["/a.js"],
        };
        const readFile = () => "no header here";
        expect(findJsPathCandidatesFromStrings(allStrings, readFile)).toEqual([]);
    });

    it("skips files that throw when read", () => {
        const allStrings = {
            "/tmp/missing.js": ["/a.js"],
        };
        const readFile = () => {
            throw new Error("ENOENT");
        };
        expect(() => findJsPathCandidatesFromStrings(allStrings, readFile)).not.toThrow();
        expect(findJsPathCandidatesFromStrings(allStrings, readFile)).toEqual([]);
    });

    it("ignores strings that don't look like JS paths", () => {
        const allStrings = {
            "/tmp/output/example.com/main.js": ["hello world", "/about"],
        };
        const readFile = () => "// File Source: https://example.com/main.js\n...";
        expect(findJsPathCandidatesFromStrings(allStrings, readFile)).toEqual([]);
    });

    it("dedupes candidates found across multiple files", () => {
        const allStrings = {
            "/tmp/output/example.com/a.js": ["/shared.js"],
            "/tmp/output/example.com/b.js": ["/shared.js"],
        };
        const readFile = () => "// File Source: https://example.com/\n...";
        expect(findJsPathCandidatesFromStrings(allStrings, readFile)).toEqual(["https://example.com/shared.js"]);
    });

    it("resolves each file's strings against that file's own distinct source URL", () => {
        const allStrings = {
            "/tmp/output/a.com/x.js": ["/only-on-a.js"],
            "/tmp/output/b.com/y.js": ["/only-on-b.js"],
        };
        const readFile = (filePath: string) =>
            filePath.includes("a.com")
                ? "// File Source: https://a.com/x.js\n..."
                : "// File Source: https://b.com/y.js\n...";
        const result = findJsPathCandidatesFromStrings(allStrings, readFile).sort();
        expect(result).toEqual(["https://a.com/only-on-a.js", "https://b.com/only-on-b.js"]);
    });
});
