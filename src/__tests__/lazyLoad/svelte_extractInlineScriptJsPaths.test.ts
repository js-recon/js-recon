import { describe, it, expect } from "vitest";
import { extractInlineScriptJsPaths } from "../../lazyLoad/svelte/svelte_getFromPageSource.js";

describe("extractInlineScriptJsPaths", () => {
    it("extracts a path from a dynamic import(...) call", () => {
        const body = `Promise.all([import("./_app/immutable/entry/start.js"), import("./_app/immutable/entry/app.js")]).then(([x, y]) => {});`;
        const result = extractInlineScriptJsPaths(body);
        expect(result).toEqual(["./_app/immutable/entry/start.js", "./_app/immutable/entry/app.js"]);
    });

    it("extracts a path from a static named import declaration", () => {
        const body = `import { start } from "./_app/immutable/start-abc123.js";\nstart({ target: document.body });`;
        const result = extractInlineScriptJsPaths(body);
        expect(result).toEqual(["./_app/immutable/start-abc123.js"]);
    });

    it("extracts a path from a static default import declaration", () => {
        const body = `import Foo from "./foo.js";`;
        expect(extractInlineScriptJsPaths(body)).toEqual(["./foo.js"]);
    });

    it("extracts a path from a static namespace import declaration", () => {
        const body = `import * as ns from "./ns.js";`;
        expect(extractInlineScriptJsPaths(body)).toEqual(["./ns.js"]);
    });

    it("extracts paths from both dynamic and static import forms in the same body, deduped", () => {
        const body = `
            import { start } from "./_app/immutable/start-abc123.js";
            Promise.all([import("./_app/immutable/entry/start.js")]);
            import { start as start2 } from "./_app/immutable/start-abc123.js";
        `;
        const result = extractInlineScriptJsPaths(body);
        expect(result).toEqual(["./_app/immutable/entry/start.js", "./_app/immutable/start-abc123.js"]);
    });

    it("does not match non-.js import specifiers", () => {
        const body = `import "./styles.css";`;
        expect(extractInlineScriptJsPaths(body)).toEqual([]);
    });

    it("returns [] for empty input", () => {
        expect(extractInlineScriptJsPaths("")).toEqual([]);
    });
});
