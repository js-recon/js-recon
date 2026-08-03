import { describe, it, expect } from "vitest";
import { extractViteMapDepsChunks } from "../../lazyLoad/vue/vue_viteMapDeps.js";

const JS_URL = "https://cdn.example.com/assets/app.B1a2C3d4.js";

// Constructs a minimal __vite__mapDeps declaration matching Vite's output shape.
function buildMapDepsCode(paths: string[]): string {
    const arr = paths.map((p) => JSON.stringify(p)).join(", ");
    return `const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=[${arr}])))=>i.map(i=>d[i]);`;
}

describe("extractViteMapDepsChunks", () => {
    it("extracts file-relative ./ chunk paths", () => {
        const code = buildMapDepsCode(["./common.abc.js", "./vendor.def.js"]);
        const result = extractViteMapDepsChunks(code, JS_URL);
        expect(result).toContain("https://cdn.example.com/assets/common.abc.js");
        expect(result).toContain("https://cdn.example.com/assets/vendor.def.js");
    });

    it("extracts root-relative bare paths against origin", () => {
        const code = buildMapDepsCode(["assets/chunk.abc.js"]);
        const result = extractViteMapDepsChunks(code, JS_URL);
        expect(result).toContain("https://cdn.example.com/assets/chunk.abc.js");
    });

    it("resolves ../ paths relative to the JS file", () => {
        const code = buildMapDepsCode(["../shared/lib.abc.js"]);
        const result = extractViteMapDepsChunks(code, JS_URL);
        expect(result).toContain("https://cdn.example.com/shared/lib.abc.js");
    });

    it("ignores non-.js entries", () => {
        const code = buildMapDepsCode(["./style.css", "./chunk.js"]);
        const result = extractViteMapDepsChunks(code, JS_URL);
        expect(result.every((u) => u.endsWith(".js"))).toBe(true);
    });

    it("returns [] when no __vite__mapDeps declaration is present", () => {
        const code = `const x = 1; function init() {}`;
        expect(extractViteMapDepsChunks(code, JS_URL)).toEqual([]);
    });

    it("returns [] for empty content", () => {
        expect(extractViteMapDepsChunks("", JS_URL)).toEqual([]);
    });

    it("returns [] for invalid JS", () => {
        expect(extractViteMapDepsChunks("{{{{ not valid %%%%", JS_URL)).toEqual([]);
    });

    it("skips malformed URL strings without aborting the manifest", () => {
        const code = `const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["http://[.js","./valid.js"])))=>i.map(i=>d[i]);`;

        expect(extractViteMapDepsChunks(code, JS_URL)).toEqual(["https://cdn.example.com/assets/valid.js"]);
    });

    it("handles multiple .js paths in one declaration", () => {
        const code = buildMapDepsCode(["./a.js", "./b.js", "./c.js", "./d.js"]);
        const result = extractViteMapDepsChunks(code, JS_URL);
        expect(result.length).toBe(4);
    });
});
