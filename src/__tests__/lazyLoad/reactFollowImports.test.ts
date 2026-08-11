import { beforeEach, describe, expect, it, vi } from "vitest";

const makeRequest = vi.hoisted(() => vi.fn());

vi.mock("../../utility/makeReq.js", () => ({ default: makeRequest }));

import reactFollowImports from "../../lazyLoad/react/react_followImports.js";

beforeEach(() => {
    makeRequest.mockReset();
});

describe("react_followImports compact output", () => {
    it("aggregates a failing batch without emitting one warning per URL", async () => {
        makeRequest.mockRejectedValue(new Error("network failed"));
        const warnSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const urls = ["https://example.test/one.js", "https://example.test/two.js", "https://example.test/three.js"];

        await expect(reactFollowImports(urls, 2, "https://example.test", new Set(), 3, true)).resolves.toEqual([]);

        expect(warnSpy).toHaveBeenCalledTimes(1);
        const warning = warnSpy.mock.calls.flat().join("\n");
        expect(warning).toContain("3");
        expect(warning).not.toContain("one.js");
    });
});
