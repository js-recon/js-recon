import { beforeEach, describe, expect, it, vi } from "vitest";
import makeRequest from "../../utility/makeReq.js";
import vueGetClientSidePaths from "../../lazyLoad/vue/vue_getClientSidePaths.js";

vi.mock("../../utility/makeReq.js", () => ({
    default: vi.fn(),
}));

const mockedMakeRequest = vi.mocked(makeRequest);

beforeEach(() => {
    mockedMakeRequest.mockReset();
});

describe("Vue client-side path URL handling", () => {
    it("skips malformed absolute strings while retaining valid paths", async () => {
        mockedMakeRequest.mockResolvedValue(
            new Response(`
                const malformed = { link: "http://[.js" };
                const valid = { link: "/dashboard" };
            `)
        );

        await expect(
            vueGetClientSidePaths("https://example.test", ["https://example.test/assets/app.js"], 2, 1, false)
        ).resolves.toEqual(["https://example.test/dashboard"]);
    });
});
