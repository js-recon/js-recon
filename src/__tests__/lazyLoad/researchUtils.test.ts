import { describe, it, expect } from "vitest";
import { accumulateTechnique, createTechniqueRecorder } from "../../lazyLoad/researchUtils.js";

describe("accumulateTechnique", () => {
    it("does nothing for an empty urls array", () => {
        const map: Record<string, string[]> = {};
        accumulateTechnique(map, "some_method", []);
        expect(map).toEqual({});
    });

    it("creates a new entry for a previously unseen technique", () => {
        const map: Record<string, string[]> = {};
        accumulateTechnique(map, "some_method", ["https://example.com/a.js"]);
        expect(map).toEqual({ some_method: ["https://example.com/a.js"] });
    });

    it("merges across repeated calls to the same technique", () => {
        const map: Record<string, string[]> = {};
        accumulateTechnique(map, "some_method", ["https://example.com/a.js"]);
        accumulateTechnique(map, "some_method", ["https://example.com/b.js"]);
        expect(map).toEqual({
            some_method: ["https://example.com/a.js", "https://example.com/b.js"],
        });
    });

    it("keeps independent techniques separate", () => {
        const map: Record<string, string[]> = {};
        accumulateTechnique(map, "method_a", ["https://example.com/a.js"]);
        accumulateTechnique(map, "method_b", ["https://example.com/b.js"]);
        expect(map).toEqual({
            method_a: ["https://example.com/a.js"],
            method_b: ["https://example.com/b.js"],
        });
    });
});

describe("createTechniqueRecorder", () => {
    it("returns a function bound to the given map", () => {
        const map: Record<string, string[]> = {};
        const record = createTechniqueRecorder(map);
        record("some_method", ["https://example.com/a.js"]);
        expect(map).toEqual({ some_method: ["https://example.com/a.js"] });
    });

    it("no-ops for empty urls", () => {
        const map: Record<string, string[]> = {};
        const record = createTechniqueRecorder(map);
        record("some_method", []);
        expect(map).toEqual({});
    });
});
