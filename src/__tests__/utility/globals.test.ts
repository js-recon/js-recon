import { describe, it, expect, afterEach } from "vitest";
import {
    addOpenapiOutput,
    getOpenapiOutput,
    clearOpenapiOutput,
    setTargetUrl,
    getTargetUrl,
} from "../../utility/globals.js";
import type { OpenapiOutputItem } from "../../utility/globals.js";

const makeItem = (overrides: Partial<OpenapiOutputItem>): OpenapiOutputItem => ({
    url: "https://example.com/api/test",
    path: "/api/test",
    method: "GET",
    chunkId: "chunk1",
    headers: {},
    body: null,
    ...overrides,
});

describe("openapiOutput accumulator", () => {
    afterEach(() => {
        clearOpenapiOutput();
    });

    it("accumulates items across multiple addOpenapiOutput calls", () => {
        clearOpenapiOutput();
        addOpenapiOutput(makeItem({ path: "/a" }));
        addOpenapiOutput(makeItem({ path: "/b" }));
        expect(getOpenapiOutput()).toHaveLength(2);
    });

    it("clearOpenapiOutput resets the collection so a later target doesn't inherit an earlier target's entries", () => {
        clearOpenapiOutput();
        addOpenapiOutput(makeItem({ path: "/target-one" }));
        expect(getOpenapiOutput()).toHaveLength(1);

        clearOpenapiOutput();
        expect(getOpenapiOutput()).toHaveLength(0);

        addOpenapiOutput(makeItem({ path: "/target-two" }));
        const result = getOpenapiOutput();
        expect(result).toHaveLength(1);
        expect(result[0].path).toBe("/target-two");
    });
});

describe("setTargetUrl / getTargetUrl", () => {
    it("strips credentials, query, and fragment from the stored target URL", () => {
        setTargetUrl("https://user:pass@example.com/api?token=secret#frag");
        expect(getTargetUrl()).toBe("https://example.com/api");
    });

    it("keeps a plain URL unchanged", () => {
        setTargetUrl("https://example.com/api");
        expect(getTargetUrl()).toBe("https://example.com/api");
    });

    it("falls back to the raw value when it isn't a parseable URL", () => {
        setTargetUrl("not-a-url");
        expect(getTargetUrl()).toBe("not-a-url");
    });
});
