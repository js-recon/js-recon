import { describe, it, expect } from "vitest";
import { decodeDataUriScript, isLikelyJsScriptType } from "../../lazyLoad/generic/generic_getScriptTags.js";

describe("decodeDataUriScript", () => {
    it("decodes a base64-encoded data URI", () => {
        const src = "console.log('hi')";
        const b64 = Buffer.from(src, "utf-8").toString("base64");
        const result = decodeDataUriScript(`data:text/javascript;base64,${b64}`);
        expect(result).toBe(src);
    });

    it("decodes a non-base64, percent-encoded data URI", () => {
        const result = decodeDataUriScript("data:text/javascript,console.log(%27hi%27)");
        expect(result).toBe("console.log('hi')");
    });

    it("returns null for a string that isn't a data URI", () => {
        expect(decodeDataUriScript("https://example.com/a.js")).toBeNull();
    });

    it("returns null when there is no comma separating meta from payload", () => {
        expect(decodeDataUriScript("data:text/javascript;base64")).toBeNull();
    });
});

describe("isLikelyJsScriptType", () => {
    it("treats a missing type as JS", () => {
        expect(isLikelyJsScriptType(undefined)).toBe(true);
    });

    it("treats an empty type as JS", () => {
        expect(isLikelyJsScriptType("")).toBe(true);
    });

    it("treats text/javascript as JS", () => {
        expect(isLikelyJsScriptType("text/javascript")).toBe(true);
    });

    it("treats module as JS", () => {
        expect(isLikelyJsScriptType("module")).toBe(true);
    });

    it("treats a Cloudflare Rocket Loader hash-prefixed type as JS", () => {
        expect(isLikelyJsScriptType("e87f2ca1d792f1da1525f2ad-text/javascript")).toBe(true);
    });

    it("rejects application/ld+json (JSON-LD structured data)", () => {
        expect(isLikelyJsScriptType("application/ld+json")).toBe(false);
    });

    it("rejects speculationrules", () => {
        expect(isLikelyJsScriptType("speculationrules")).toBe(false);
    });

    it("rejects application/json", () => {
        expect(isLikelyJsScriptType("application/json")).toBe(false);
    });

    it("rejects known templating types", () => {
        expect(isLikelyJsScriptType("text/template")).toBe(false);
        expect(isLikelyJsScriptType("text/x-handlebars-template")).toBe(false);
    });

    it("defaults unrecognized types to JS", () => {
        expect(isLikelyJsScriptType("text/babel")).toBe(true);
    });

    it("is case-insensitive", () => {
        expect(isLikelyJsScriptType("APPLICATION/LD+JSON")).toBe(false);
        expect(isLikelyJsScriptType("TEXT/JAVASCRIPT")).toBe(true);
    });
});
