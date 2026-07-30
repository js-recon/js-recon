import { beforeEach, describe, expect, it, vi } from "vitest";

const discover = vi.hoisted(() => vi.fn());

vi.mock("../../lazyLoad/vue/vue_discoverJsFiles.js", () => ({ default: discover }));

import vueRecursiveClientSidePathDownload from "../../lazyLoad/vue/vue_recursiveClientSidePathDownload.js";

beforeEach(() => {
    discover.mockReset();
    discover.mockResolvedValue({ jsFiles: ["https://example.test/chunk.js"], clientSidePaths: [] });
});

describe("Vue recursive progress ownership", () => {
    it("suppresses nested progress bars while sibling page discoveries run concurrently", async () => {
        await vueRecursiveClientSidePathDownload(
            ["https://example.test/one", "https://example.test/two"],
            2,
            2,
            undefined,
            [],
            []
        );

        expect(discover).toHaveBeenCalledTimes(2);
        for (const call of discover.mock.calls) {
            expect(call[6]).toBe(false);
            expect(call[7]).toBe(false);
        }
    });

    it("keeps nested bars and prompts disabled for a single recursive page", async () => {
        await vueRecursiveClientSidePathDownload(["https://example.test/one"], 1, 2, undefined, [], []);

        expect(discover).toHaveBeenCalledTimes(1);
        expect(discover.mock.calls[0][6]).toBe(false);
        expect(discover.mock.calls[0][7]).toBe(false);
    });
});
