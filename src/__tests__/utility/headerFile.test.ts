import { describe, it, expect } from "vitest";
import {
    parseHeaderFileContent,
    HeaderFileError,
    normalizeOrigin,
    buildOriginAllowlist,
    originAllowed,
} from "../../utility/headerFile.js";

describe("parseHeaderFileContent", () => {
    it("parses a single header entry", () => {
        expect(parseHeaderFileContent("Authorization: Bearer test123")).toEqual([
            { name: "Authorization", value: "Bearer test123" },
        ]);
    });

    it("parses 16 header entries", () => {
        const lines = Array.from({ length: 16 }, (_, i) => `X-Header-${i}: value-${i}`);
        const result = parseHeaderFileContent(lines.join("\n"));
        expect(result).toHaveLength(16);
        expect(result[15]).toEqual({ name: "X-Header-15", value: "value-15" });
    });

    it("tolerates a single trailing newline", () => {
        expect(parseHeaderFileContent("X-Api-Key: abc\n")).toEqual([{ name: "X-Api-Key", value: "abc" }]);
    });

    it("strips exactly one separator space and preserves extra colons/spaces", () => {
        expect(parseHeaderFileContent("Cookie:  a=1; b=2:3")).toEqual([{ name: "Cookie", value: " a=1; b=2:3" }]);
    });

    it("preserves a value with no leading space after the colon", () => {
        expect(parseHeaderFileContent("X-Api-Key:abc")).toEqual([{ name: "X-Api-Key", value: "abc" }]);
    });

    it("rejects an empty file", () => {
        expect(() => parseHeaderFileContent("")).toThrow(HeaderFileError);
    });

    it("rejects more than 16 entries", () => {
        const lines = Array.from({ length: 17 }, (_, i) => `X-Header-${i}: v`);
        expect(() => parseHeaderFileContent(lines.join("\n"))).toThrow(HeaderFileError);
    });

    it("rejects a blank line", () => {
        expect(() => parseHeaderFileContent("X-Api-Key: abc\n\nX-Other: def")).toThrow(HeaderFileError);
    });

    it("rejects a comment line", () => {
        expect(() => parseHeaderFileContent("# comment\nX-Api-Key: abc")).toThrow(HeaderFileError);
    });

    it("rejects a line with no colon", () => {
        expect(() => parseHeaderFileContent("NotAHeader")).toThrow(HeaderFileError);
    });

    it("rejects an invalid header name (non-token characters)", () => {
        expect(() => parseHeaderFileContent("Bad Name: abc")).toThrow(HeaderFileError);
    });

    it("rejects an empty value", () => {
        expect(() => parseHeaderFileContent("X-Empty:")).toThrow(HeaderFileError);
    });

    it("rejects case-only duplicate header names", () => {
        expect(() => parseHeaderFileContent("Authorization: a\nauthorization: b")).toThrow(HeaderFileError);
    });

    it("rejects a header name over 256 bytes", () => {
        const longName = "X-" + "A".repeat(300);
        expect(() => parseHeaderFileContent(`${longName}: v`)).toThrow(HeaderFileError);
    });

    it("rejects a value over 16384 bytes", () => {
        const longValue = "a".repeat(16_385);
        expect(() => parseHeaderFileContent(`X-Big: ${longValue}`)).toThrow(HeaderFileError);
    });

    it("does not leak header name/value into the thrown error message", () => {
        expect.assertions(2);
        try {
            parseHeaderFileContent("X-Key: SECRET_MARKER_VALUE_XYZ789\nX-Key: SECRET_MARKER_VALUE_XYZ789");
        } catch (error) {
            expect((error as Error).message).not.toContain("SECRET_MARKER_VALUE_XYZ789");
            expect((error as Error).message).not.toContain("X-Key");
        }
    });
});

describe("normalizeOrigin", () => {
    it("lowercases the host and applies the default HTTPS port", () => {
        expect(normalizeOrigin("https://Example.COM/path")).toBe("https://example.com:443");
    });

    it("applies the default HTTP port", () => {
        expect(normalizeOrigin("http://example.com/path")).toBe("http://example.com:80");
    });

    it("preserves an explicit non-default port", () => {
        expect(normalizeOrigin("https://example.com:8443/path")).toBe("https://example.com:8443");
    });

    it("returns null for a non-HTTP(S) scheme", () => {
        expect(normalizeOrigin("ftp://example.com/file")).toBeNull();
    });

    it("returns null for an unparseable URL", () => {
        expect(normalizeOrigin("not a url")).toBeNull();
    });
});

describe("buildOriginAllowlist / originAllowed", () => {
    it("allows a URL whose origin matches an explicitly-supplied target", () => {
        const allowlist = buildOriginAllowlist(["https://example.com/"]);
        expect(originAllowed("https://example.com/api/data", allowlist)).toBe(true);
    });

    it("rejects a different host", () => {
        const allowlist = buildOriginAllowlist(["https://example.com/"]);
        expect(originAllowed("https://cdn.example.com/chunk.js", allowlist)).toBe(false);
    });

    it("rejects a different scheme", () => {
        const allowlist = buildOriginAllowlist(["https://example.com/"]);
        expect(originAllowed("http://example.com/", allowlist)).toBe(false);
    });

    it("rejects a different explicit port", () => {
        const allowlist = buildOriginAllowlist(["https://example.com/"]);
        expect(originAllowed("https://example.com:8443/", allowlist)).toBe(false);
    });
});
