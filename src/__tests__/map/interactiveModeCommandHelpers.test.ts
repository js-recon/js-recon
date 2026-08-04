import { describe, it, expect } from "vitest";
import commandHelpers from "../../map/interactive-mode/commandHelpers.js";
import { Chunks } from "../../utility/interfaces.js";
import { State } from "../../map/interactive-mode/interactive.js";

const makeChunk = (overrides: Partial<Chunks[string]> = {}): Chunks[string] => ({
    id: "chunk-a",
    description: "none",
    loadedOn: [],
    containsFetch: false,
    isAxiosLibrary: false,
    exports: [],
    callStack: [],
    code: "function chunkA() {}",
    imports: [],
    file: "a.js",
    ...overrides,
});

const makeState = (overrides: Partial<State> = {}): State => ({
    chunks: {},
    lastCommandStatus: true,
    functionNavHistory: [],
    functionNavHistoryIndex: -1,
    funcWriteFile: undefined,
    commandHistory: [],
    commandHistoryIndex: -1,
    writeimports: false,
    mapFile: "mapped.json",
    ...overrides,
});

describe("listAllFunctions", () => {
    it("lists every chunk with its description and file", () => {
        const chunks: Chunks = {
            "chunk-a": makeChunk({ id: "chunk-a", description: "does a thing", file: "a.js" }),
            "chunk-b": makeChunk({ id: "chunk-b", description: "does another thing", file: "b.js" }),
        };
        const result = commandHelpers.listAllFunctions(chunks);
        expect(result).toContain("chunk-a: does a thing (a.js)");
        expect(result).toContain("chunk-b: does another thing (b.js)");
    });

    it("returns just the header for an empty chunk set", () => {
        const result = commandHelpers.listAllFunctions({});
        expect(result).toContain("List of all functions");
    });
});

describe("listNonEmptyDescriptionFunctions", () => {
    it("only lists chunks whose description is not the literal string 'none'", () => {
        const chunks: Chunks = {
            "chunk-a": makeChunk({ id: "chunk-a", description: "has a description" }),
            "chunk-b": makeChunk({ id: "chunk-b", description: "none" }),
        };
        const result = commandHelpers.listNonEmptyDescriptionFunctions(chunks);
        expect(result).toContain("chunk-a: has a description");
        expect(result).not.toContain("chunk-b");
    });

    it("reports no functions found when every description is 'none'", () => {
        const chunks: Chunks = { "chunk-a": makeChunk({ description: "none" }) };
        const result = commandHelpers.listNonEmptyDescriptionFunctions(chunks);
        expect(result).toContain("No functions with non-empty descriptions");
    });
});

describe("navHistory", () => {
    it("reports no navigation history for an empty list", () => {
        const result = commandHelpers.navHistory({}, []);
        expect(result).toContain("No navigation history");
    });

    it("lists known chunk IDs with their description", () => {
        const chunks: Chunks = { "chunk-a": makeChunk({ id: "chunk-a", description: "a description" }) };
        const result = commandHelpers.navHistory(chunks, ["chunk-a"]);
        expect(result).toContain("chunk-a: a description");
    });

    it("flags nav-history entries whose chunk no longer exists", () => {
        const result = commandHelpers.navHistory({}, ["missing-chunk"]);
        expect(result).toContain("missing-chunk: <function not found>");
    });
});

describe("traceFunction", () => {
    it("reports function not found for an unknown ID", () => {
        const result = commandHelpers.traceFunction({}, "missing-chunk");
        expect(result).toContain("Function missing-chunk not found");
    });

    it("lists imports and exports for a known chunk", () => {
        const chunks: Chunks = {
            "chunk-a": makeChunk({ id: "chunk-a", imports: ["chunk-b"] }),
            "chunk-b": makeChunk({ id: "chunk-b", description: "imported helper", imports: ["chunk-a"] }),
        };
        const result = commandHelpers.traceFunction(chunks, "chunk-a");
        expect(result).toContain("Imports:");
        expect(result).toContain("chunk-b: imported helper");
        expect(result).toContain("Exports:");
        expect(result).toContain("chunk-b: imported helper");
    });

    it("reports no imports/exports when a chunk has neither", () => {
        const chunks: Chunks = { "chunk-a": makeChunk({ id: "chunk-a", imports: [] }) };
        const result = commandHelpers.traceFunction(chunks, "chunk-a");
        expect(result).toContain("No imports");
        expect(result).toContain("No exports");
    });
});

describe("getExportNames", () => {
    it("returns an error for an unknown chunk ID", () => {
        const result = commandHelpers.getExportNames({}, "missing-chunk");
        expect(result).toContain("Chunk missing-chunk not found");
    });

    it("lists export names for a specific chunk", () => {
        const chunks: Chunks = { "chunk-a": makeChunk({ id: "chunk-a", exports: ["foo", "bar"] }) };
        const result = commandHelpers.getExportNames(chunks, "chunk-a");
        expect(result).toContain("foo");
        expect(result).toContain("bar");
    });

    it("reports no exports for a chunk with an empty exports list", () => {
        const chunks: Chunks = { "chunk-a": makeChunk({ id: "chunk-a", exports: [] }) };
        const result = commandHelpers.getExportNames(chunks, "chunk-a");
        expect(result).toContain("No exports");
    });

    it("lists all chunks and their exports for the 'all' pseudo-ID", () => {
        const chunks: Chunks = { "chunk-a": makeChunk({ id: "chunk-a", exports: ["foo"] }) };
        const result = commandHelpers.getExportNames(chunks, "all");
        expect(result).toContain("chunk-a");
        expect(result).toContain("foo");
    });

    it("only lists chunks with non-empty exports for the 'nonempty' pseudo-ID", () => {
        const chunks: Chunks = {
            "chunk-a": makeChunk({ id: "chunk-a", exports: ["foo"] }),
            "chunk-b": makeChunk({ id: "chunk-b", exports: [] }),
        };
        const result = commandHelpers.getExportNames(chunks, "nonempty");
        expect(result).toContain("chunk-a");
        expect(result).not.toContain("chunk-b");
    });
});

describe("getFunctionCode", () => {
    it("returns the prettified code for a known chunk", async () => {
        const chunks: Chunks = { "chunk-a": makeChunk({ id: "chunk-a", code: "function chunkA(){return 1}" }) };
        const state = makeState({ chunks });
        const result = await commandHelpers.getFunctionCode(chunks, "chunk-a", state);
        expect(result).toContain("function chunkA()");
        expect(result).toContain("return 1");
    });

    it("appends import code when writeimports is enabled", async () => {
        const chunks: Chunks = {
            "chunk-a": makeChunk({ id: "chunk-a", code: "function chunkA(){}", imports: ["chunk-b"] }),
            "chunk-b": makeChunk({ id: "chunk-b", description: "helper", code: "function chunkB(){}" }),
        };
        const state = makeState({ chunks, writeimports: true });
        const result = await commandHelpers.getFunctionCode(chunks, "chunk-a", state);
        expect(result).toContain("Imports:");
        expect(result).toContain("function chunkB()");
    });
});
