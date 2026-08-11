import { describe, it, expect } from "vitest";
import { synthesizeFilename } from "../../lazyLoad/generic/generic_downloadFiles.js";

describe("synthesizeFilename", () => {
    it("passes through a normal .js filename unchanged", () => {
        expect(synthesizeFilename("https://example.com/static/js/main.js")).toBe("main.js");
    });

    it("passes through a normal .mjs filename unchanged", () => {
        expect(synthesizeFilename("https://example.com/static/js/main.mjs")).toBe("main.mjs");
    });

    it("synthesizes a filename from a .js path segment that isn't last (cachebuster shape)", () => {
        const result = synthesizeFilename("https://example.com/beacon.min.js/v124/token");
        expect(result).toMatch(/^beacon\.min-[0-9a-f]{8}\.js$/);
    });

    it("is deterministic for the same URL", () => {
        const url = "https://example.com/beacon.min.js/v124/token";
        expect(synthesizeFilename(url)).toBe(synthesizeFilename(url));
    });

    it("falls back to a pure hash filename when no segment contains .js", () => {
        const result = synthesizeFilename("https://example.com/assets/a1b2c3d4e5");
        expect(result).toMatch(/^[0-9a-f]{8}\.js$/);
    });
});
