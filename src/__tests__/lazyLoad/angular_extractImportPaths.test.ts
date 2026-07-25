import { describe, it, expect } from "vitest";
import { extractImportPaths } from "../../lazyLoad/angular/angular_recursiveChunkImports.js";

describe("extractImportPaths", () => {
    it("extracts a dynamic import() path", () => {
        const code = `function loadRoute() { return import("./chunk-abc123.js"); }`;
        expect(extractImportPaths(code)).toEqual(["./chunk-abc123.js"]);
    });

    it("extracts a static ImportDeclaration path", () => {
        const code = `import { a as X } from "./chunk-def456.js";`;
        expect(extractImportPaths(code)).toEqual(["./chunk-def456.js"]);
    });

    it("extracts both dynamic and static imports from the same file", () => {
        const code = `
            import { a as X } from "./chunk-def456.js";
            function loadRoute() { return import("./chunk-abc123.js"); }
        `;
        const result = extractImportPaths(code);
        expect(result).toContain("./chunk-def456.js");
        expect(result).toContain("./chunk-abc123.js");
        expect(result).toHaveLength(2);
    });

    it("extracts multiple static imports", () => {
        const code = `
            import { a as X } from "./chunk-1.js";
            import { b as Y } from "./chunk-2.js";
        `;
        expect(extractImportPaths(code)).toEqual(["./chunk-1.js", "./chunk-2.js"]);
    });

    it("returns [] for a file with no imports", () => {
        expect(extractImportPaths(`const x = 1; console.log(x);`)).toEqual([]);
    });

    it("returns [] for empty input", () => {
        expect(extractImportPaths("")).toEqual([]);
    });

    it("returns [] for malformed JS", () => {
        expect(extractImportPaths("{{{{ not valid")).toEqual([]);
    });
});
