import { describe, it, expect } from "vitest";
import * as cheerio from "cheerio";
import { isSvelteDevServer } from "../../lazyLoad/techDetect/checkSvelteDevServer.js";

const $ = (html: string) => cheerio.load(html);

describe("isSvelteDevServer", () => {
    it("detects the __sveltekit_dev global in an inline script block", () => {
        const result = isSvelteDevServer(
            $(`<html><body><script>{__sveltekit_dev = { base: "", env: {} };}</script></body></html>`),
            "http://localhost:5173"
        );
        expect(result).toBe(true);
    });

    it("does not false-positive on __sveltekit_dev inside a script src attribute", () => {
        const result = isSvelteDevServer(
            $(`<html><body><script src="/assets/__sveltekit_dev.js"></script></body></html>`),
            "http://localhost:5173"
        );
        expect(result).toBe(false);
    });

    it("detects the Vite client script by pathname", () => {
        const result = isSvelteDevServer(
            $(`<html><head><script type="module" src="/@vite/client"></script></head></html>`),
            "http://localhost:5173"
        );
        expect(result).toBe(true);
    });

    it("detects the Vite client script even with a query string appended", () => {
        const result = isSvelteDevServer(
            $(`<html><head><script type="module" src="/@vite/client?t=123"></script></head></html>`),
            "http://localhost:5173"
        );
        expect(result).toBe(true);
    });

    it("does not false-positive on a query string that merely contains @vite/client", () => {
        const result = isSvelteDevServer(
            $(`<html><head><script src="/assets/main.js?ref=/@vite/client"></script></head></html>`),
            "http://localhost:5173"
        );
        expect(result).toBe(false);
    });

    it("falls back to intercepted URLs when no HTML-level marker is present", () => {
        const result = isSvelteDevServer($(`<html><head></head></html>`), "http://localhost:5173", [
            "http://localhost:5173/@vite/client",
        ]);
        expect(result).toBe(true);
    });

    it("returns false for an empty document with no intercepted URLs", () => {
        const result = isSvelteDevServer($(`<html><head></head></html>`), "http://localhost:5173");
        expect(result).toBe(false);
    });

    it("resolves a relative src against baseUrl before checking the pathname", () => {
        const result = isSvelteDevServer(
            $(`<html><head><script type="module" src="@vite/client"></script></head></html>`),
            "http://localhost:5173/"
        );
        expect(result).toBe(true);
    });
});
