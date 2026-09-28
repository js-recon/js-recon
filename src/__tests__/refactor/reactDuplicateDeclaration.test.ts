import { describe, it, expect } from "vitest";
import refactorReact from "../../refactor/react/index.js";
import type { Chunk } from "../../utility/interfaces.js";

const makeChunk = (id: string, code: string): Chunk => ({
    id,
    description: "",
    loadedOn: [],
    containsFetch: false,
    isAxiosLibrary: false,
    exports: [],
    callStack: [],
    code,
    imports: [],
    file: `${id}.js`,
});

describe("refactorReact", () => {
    // Babel's parser recovers from duplicate lexical declarations, but traverse's scope
    // builder throws on them — the chunk must be skipped, not abort the refactor.
    it("skips a chunk with a duplicate lexical declaration instead of throwing", async () => {
        const chunk = makeChunk(
            "dup",
            "(() => { var e = { 1: function (e, n, t) { const a = 1; const a = 2; n.a = a; } }; })();"
        );
        const result = await refactorReact(chunk);
        expect(result.files).toEqual({});
        expect(result.libModuleMap.size).toBe(0);
    });

    it("still refactors a valid chunk", async () => {
        const chunk = makeChunk("ok", "(() => { var e = { 1: function (e, n, t) { n.a = 1; } }; })();");
        const result = await refactorReact(chunk);
        expect(Object.keys(result.files)).toContain("1");
    });
});
