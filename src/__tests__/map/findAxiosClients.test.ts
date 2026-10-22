import { describe, it, expect } from "vitest";
import { findAxiosClients } from "../../map/babel-legacy/next_js/resolveAxiosHelpers/findAxiosClients.js";
import type { Chunks } from "../../utility/interfaces.js";

function makeChunk(overrides: Partial<Chunks[string]> = {}): Chunks[string] {
    return {
        id: "",
        description: "",
        loadedOn: [],
        containsFetch: false,
        isAxiosLibrary: false,
        exports: [],
        callStack: [],
        code: "",
        imports: [],
        file: "",
        ...overrides,
    };
}

describe("findAxiosClients", () => {
    it("returns empty arrays when no axios libraries exist", () => {
        const chunks: Chunks = {
            "chunk-a": makeChunk({ imports: ["chunk-b"] }),
            "chunk-b": makeChunk(),
        };
        const result = findAxiosClients(chunks);
        expect(result.axiosExportedFrom).toEqual([]);
        expect(result.axiosImportedTo).toEqual({});
    });

    it("identifies a chunk that is an axios library", () => {
        const chunks: Chunks = {
            "axios-lib": makeChunk({ isAxiosLibrary: true }),
            "app-chunk": makeChunk({ imports: ["axios-lib"] }),
        };
        const result = findAxiosClients(chunks);
        expect(result.axiosExportedFrom).toContain("axios-lib");
    });

    it("maps importer to the axios library it imports", () => {
        const chunks: Chunks = {
            "axios-lib": makeChunk({ isAxiosLibrary: true }),
            "app-chunk": makeChunk({ imports: ["axios-lib"] }),
        };
        const result = findAxiosClients(chunks);
        expect(result.axiosImportedTo["app-chunk"]).toBe("axios-lib");
    });

    it("does not include non-importing chunks in axiosImportedTo", () => {
        const chunks: Chunks = {
            "axios-lib": makeChunk({ isAxiosLibrary: true }),
            unrelated: makeChunk({ imports: ["other-chunk"] }),
        };
        const result = findAxiosClients(chunks);
        expect(result.axiosImportedTo).not.toHaveProperty("unrelated");
    });

    it("handles multiple axios libraries imported by different chunks", () => {
        const chunks: Chunks = {
            "axios-lib-1": makeChunk({ isAxiosLibrary: true }),
            "axios-lib-2": makeChunk({ isAxiosLibrary: true }),
            "consumer-a": makeChunk({ imports: ["axios-lib-1"] }),
            "consumer-b": makeChunk({ imports: ["axios-lib-2"] }),
        };
        const result = findAxiosClients(chunks);
        expect(result.axiosExportedFrom).toHaveLength(2);
        expect(result.axiosImportedTo["consumer-a"]).toBe("axios-lib-1");
        expect(result.axiosImportedTo["consumer-b"]).toBe("axios-lib-2");
    });

    it("returns empty result for empty chunks object", () => {
        const result = findAxiosClients({});
        expect(result.axiosExportedFrom).toEqual([]);
        expect(result.axiosImportedTo).toEqual({});
    });
});
