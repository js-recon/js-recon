import { describe, it, expect } from "vitest";
import { customHeadersToRecord, parseHeaderFlagValue } from "../../utility/customHeaders.js";

describe("customHeadersToRecord", () => {
    it("returns an empty object for an empty array", () => {
        expect(customHeadersToRecord([])).toEqual({});
    });

    it("folds name/value pairs into a record", () => {
        const result = customHeadersToRecord([
            { name: "Authorization", value: "Bearer test123" },
            { name: "X-Api-Key", value: "abc" },
        ]);
        expect(result).toEqual({ Authorization: "Bearer test123", "X-Api-Key": "abc" });
    });

    it("lets later entries win on duplicate names", () => {
        const result = customHeadersToRecord([
            { name: "X-Api-Key", value: "first" },
            { name: "X-Api-Key", value: "second" },
        ]);
        expect(result).toEqual({ "X-Api-Key": "second" });
    });
});

describe("parseHeaderFlagValue", () => {
    it("parses a simple 'Name: Value' pair", () => {
        expect(parseHeaderFlagValue("Authorization: Bearer test123")).toEqual({
            name: "Authorization",
            value: "Bearer test123",
        });
    });

    it("trims whitespace on both sides", () => {
        expect(parseHeaderFlagValue("  X-Api-Key  :   abc  ")).toEqual({ name: "X-Api-Key", value: "abc" });
    });

    it("keeps everything after the first colon as the value", () => {
        expect(parseHeaderFlagValue("Cookie: a=1; b=2:3")).toEqual({ name: "Cookie", value: "a=1; b=2:3" });
    });

    it("allows an empty value after the colon", () => {
        expect(parseHeaderFlagValue("X-Empty:")).toEqual({ name: "X-Empty", value: "" });
    });

    it("returns null when there is no colon separator", () => {
        expect(parseHeaderFlagValue("NotAHeader")).toBeNull();
    });

    it("returns null when the name is empty", () => {
        expect(parseHeaderFlagValue(": value")).toBeNull();
    });
});
