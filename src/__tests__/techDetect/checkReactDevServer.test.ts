import { beforeEach, describe, expect, it, vi } from "vitest";
import * as cheerio from "cheerio";

const makeRequest = vi.hoisted(() => vi.fn());
vi.mock("../../utility/makeReq.js", () => ({ default: makeRequest }));

const { isReactDevServer } = await import("../../lazyLoad/techDetect/checkReactDevServer.js");

const $ = (html: string) => cheerio.load(html);

beforeEach(() => {
    makeRequest.mockReset();
});

describe("isReactDevServer — Vite markers", () => {
    it("detects @react-refresh in an inline script", async () => {
        const result = await isReactDevServer(
            $(
                `<html><head><script type="module">import { injectIntoGlobalHook } from "/@react-refresh";</script></head></html>`
            ),
            "http://localhost:3000"
        );
        expect(result).toBe(true);
        expect(makeRequest).not.toHaveBeenCalled();
    });

    it("detects a /@react-refresh script src via the URL pathname", async () => {
        const result = await isReactDevServer(
            $(`<html><head><script type="module" src="/@react-refresh"></script></head></html>`),
            "http://localhost:3000"
        );
        expect(result).toBe(true);
    });

    it("falls back to intercepted URLs for /@react-refresh", async () => {
        const result = await isReactDevServer($(`<html><head></head></html>`), "http://localhost:3000", [
            "http://localhost:3000/@react-refresh",
        ]);
        expect(result).toBe(true);
    });

    it("does not false-positive on a query string that merely contains the marker text", async () => {
        makeRequest.mockResolvedValue({ text: async () => "// production build" });
        const result = await isReactDevServer(
            $(`<html><head><script src="/main.js?ref=@react-refresh"></script></head></html>`),
            "http://localhost:3000"
        );
        expect(result).toBe(false);
    });
});

describe("isReactDevServer — webpack markers", () => {
    it("detects webpack-dev-server markers in a same-origin script body", async () => {
        makeRequest.mockResolvedValue({
            text: async () => `/*!*** ./node_modules/webpack-dev-server/client/index.js ***!*/\nwebpackHotUpdate(...)`,
        });
        const result = await isReactDevServer(
            $(`<html><head><script src="/assets/main.abc123.js"></script></head></html>`),
            "http://localhost:3000"
        );
        expect(result).toBe(true);
    });

    it("does not fetch cross-origin scripts", async () => {
        const result = await isReactDevServer(
            $(`<html><head><script src="https://cdn.example.test/vendor.js"></script></head></html>`),
            "http://localhost:3000"
        );
        expect(result).toBe(false);
        expect(makeRequest).not.toHaveBeenCalled();
    });

    it("returns false for a production build with no dev markers in its scripts", async () => {
        makeRequest.mockResolvedValue({ text: async () => "console.log('production bundle')" });
        const result = await isReactDevServer(
            $(`<html><head><script src="/assets/main.abc123.js"></script></head></html>`),
            "http://localhost:3000"
        );
        expect(result).toBe(false);
    });

    it("returns false for an empty document with no scripts", async () => {
        const result = await isReactDevServer($(`<html><head></head></html>`), "http://localhost:3000");
        expect(result).toBe(false);
        expect(makeRequest).not.toHaveBeenCalled();
    });
});
