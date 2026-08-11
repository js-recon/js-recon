import { describe, it, expect } from "vitest";
import { extractServerActionIds } from "../../lazyLoad/next_js/next_serverActionIdScan.js";

describe("extractServerActionIds", () => {
    it("extracts an ID from a direct member-call form", () => {
        const chunk = 'X.createServerReference("a1b2c3d4e5f60718293a4b5c6d7e8f9012345678", null, ...)';
        expect(extractServerActionIds(chunk)).toEqual(["a1b2c3d4e5f60718293a4b5c6d7e8f9012345678"]);
    });

    it("extracts an ID from the minified sequence-expression form", () => {
        const chunk = '(0, X.createServerReference)("a1b2c3d4e5f60718293a4b5c6d7e8f9012345678", e.bind(null))';
        expect(extractServerActionIds(chunk)).toEqual(["a1b2c3d4e5f60718293a4b5c6d7e8f9012345678"]);
    });

    it("normalizes IDs to lowercase and dedupes", () => {
        const id = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
        const chunk = `createServerReference("${id.toUpperCase()}") createServerReference("${id}")`;
        expect(extractServerActionIds(chunk)).toEqual([id]);
    });

    it("ignores strings shorter than 40 hex characters", () => {
        expect(extractServerActionIds('createServerReference("deadbeef")')).toEqual([]);
    });

    it("ignores non-hex strings even at sufficient length", () => {
        expect(extractServerActionIds('createServerReference("not-a-valid-hex-string-of-forty-plus-chars!!")')).toEqual(
            []
        );
    });

    it("returns [] when createServerReference is absent", () => {
        expect(extractServerActionIds("function noop() { return 1; }")).toEqual([]);
    });

    it("returns [] for empty input", () => {
        expect(extractServerActionIds("")).toEqual([]);
    });

    it("extracts multiple distinct IDs from the same chunk", () => {
        const idA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
        const idB = "b2c3d4e5f60718293a4b5c6d7e8f9012345678a1";
        const chunk = `createServerReference("${idA}"); createServerReference("${idB}");`;
        expect(extractServerActionIds(chunk).sort()).toEqual([idA, idB].sort());
    });
});
