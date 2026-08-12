import { describe, it, expect } from "vitest";
import { decodeInlineSourceMapDataUri } from "../../lazyLoad/sourcemap.js";

const validMap = JSON.stringify({
    version: 3,
    sources: ["src/app.ts"],
    sourcesContent: ["const x = 1;"],
    mappings: "AAAA",
});

describe("decodeInlineSourceMapDataUri", () => {
    it("decodes a base64-encoded inline source map", () => {
        const b64 = Buffer.from(validMap, "utf-8").toString("base64");
        const result = decodeInlineSourceMapDataUri(`data:application/json;base64,${b64}`);
        expect(result).toBe(validMap);
    });

    it("decodes a base64-encoded inline source map with a charset parameter", () => {
        const b64 = Buffer.from(validMap, "utf-8").toString("base64");
        const result = decodeInlineSourceMapDataUri(`data:application/json;charset=utf-8;base64,${b64}`);
        expect(result).toBe(validMap);
    });

    it("decodes a non-base64, percent-encoded inline source map", () => {
        const encoded = encodeURIComponent(validMap);
        const result = decodeInlineSourceMapDataUri(`data:application/json,${encoded}`);
        expect(result).toBe(validMap);
    });

    it("returns null for malformed base64 payload", () => {
        const result = decodeInlineSourceMapDataUri("data:application/json;base64,{not valid json at all}");
        expect(result).toBeNull();
    });

    it("returns null when decoded content has no sources array", () => {
        const noSources = JSON.stringify({ version: 3, mappings: "AAAA" });
        const b64 = Buffer.from(noSources, "utf-8").toString("base64");
        const result = decodeInlineSourceMapDataUri(`data:application/json;base64,${b64}`);
        expect(result).toBeNull();
    });

    it("returns null for a string that isn't a data URI", () => {
        expect(decodeInlineSourceMapDataUri("https://example.com/app.js.map")).toBeNull();
    });

    it("returns null when there is no comma separating meta from payload", () => {
        expect(decodeInlineSourceMapDataUri("data:application/json;base64")).toBeNull();
    });
});
