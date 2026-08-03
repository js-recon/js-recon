import { describe, it, expect } from "vitest";
import { getURLDirectory, hostMatchesScope, toOutputHost } from "../../utility/urlUtils.js";

describe("getURLDirectory", () => {
    it("extracts host and directory from a standard JS URL", () => {
        const result = getURLDirectory("https://vercel.com/static/js/main.js");
        expect(result.host).toBe("vercel.com");
        expect(result.directory).toBe("/static/js");
    });

    it("returns empty directory for a file at root", () => {
        const result = getURLDirectory("https://example.com/main.js");
        expect(result.host).toBe("example.com");
        expect(result.directory).toBe("");
    });

    it("replaces colon with underscore in host when port is present", () => {
        const result = getURLDirectory("http://localhost:3000/static/chunk.js");
        expect(result.host).toBe(toOutputHost("localhost:3000"));
        expect(result.directory).toBe("/static");
    });

    it("normalizes every IPv6 host separator", () => {
        const result = getURLDirectory("http://[::1]:3000/static/chunk.js");
        expect(result.host).toBe(toOutputHost("[::1]:3000"));
        expect(result.directory).toBe("/static");
    });

    it("handles URL with query string — strips filename", () => {
        const result = getURLDirectory("https://cdn.example.com/assets/app.bundle.js?v=abc123");
        expect(result.host).toBe("cdn.example.com");
        expect(result.directory).toBe("/assets");
    });

    it("handles deeply nested directory path", () => {
        const result = getURLDirectory("https://site.com/a/b/c/d/file.js");
        expect(result.host).toBe("site.com");
        expect(result.directory).toBe("/a/b/c/d");
    });

    it("returns empty directory when path has no subdirectory", () => {
        const result = getURLDirectory("https://example.com/bundle.js");
        expect(result.host).toBe("example.com");
        expect(result.directory).toBe("");
    });

    it("handles URL with no file extension — treats trailing segment as directory", () => {
        const result = getURLDirectory("https://example.com/api/v1/resource");
        expect(result.host).toBe("example.com");
        expect(result.directory).toBe("/api/v1/resource");
    });

    it("handles URL with hash fragment", () => {
        const result = getURLDirectory("https://example.com/static/js/app.js#hash");
        expect(result.host).toBe("example.com");
        expect(result.directory).toBe("/static/js");
    });
});

describe("hostMatchesScope", () => {
    it("matches canonical raw port and IPv6 hosts without filesystem-normalization collisions", () => {
        expect(hostMatchesScope("localhost:3000", ["localhost:3000"])).toBe(true);
        expect(hostMatchesScope("[::1]:3000", ["[::1]:3000"])).toBe(true);
        expect(hostMatchesScope("localhost_3000", ["localhost:3000"])).toBe(false);
        expect(hostMatchesScope("outside.test", ["[::1]:3000"])).toBe(false);
    });
});

describe("toOutputHost", () => {
    it("keeps lossy and literal host identities in distinct directories", () => {
        const encodedPortHost = toOutputHost("localhost:3000");

        expect(encodedPortHost).not.toBe(toOutputHost("localhost_3000"));
        expect(toOutputHost(encodedPortHost)).not.toBe(encodedPortHost);
    });
});
