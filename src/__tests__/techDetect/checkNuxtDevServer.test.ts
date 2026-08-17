import { describe, it, expect } from "vitest";
import * as cheerio from "cheerio";
import { isNuxtDevServer } from "../../lazyLoad/techDetect/checkNuxtDevServer.js";

const $ = (html: string) => cheerio.load(html);

describe("isNuxtDevServer", () => {
    it("detects the Nuxt-prefixed Vite client script by pathname", () => {
        const result = isNuxtDevServer(
            $(`<html><head><script type="module" src="/_nuxt/@vite/client" crossorigin></script></head></html>`),
            "http://localhost:3000"
        );
        expect(result).toBe(true);
    });

    it("detects the Nuxt Vite client script even with a query string appended", () => {
        const result = isNuxtDevServer(
            $(`<html><head><script type="module" src="/_nuxt/@vite/client?t=123"></script></head></html>`),
            "http://localhost:3000"
        );
        expect(result).toBe(true);
    });

    it("does not false-positive on vanilla Vite's root /@vite/client path", () => {
        const result = isNuxtDevServer(
            $(`<html><head><script type="module" src="/@vite/client"></script></head></html>`),
            "http://localhost:3000"
        );
        expect(result).toBe(false);
    });

    it("does not false-positive on a query string that merely contains /_nuxt/@vite/client", () => {
        const result = isNuxtDevServer(
            $(`<html><head><script src="/assets/main.js?ref=/_nuxt/@vite/client"></script></head></html>`),
            "http://localhost:3000"
        );
        expect(result).toBe(false);
    });

    it("detects the __NUXT_DEVTOOLS_TIME_METRIC__ inline script global", () => {
        const result = isNuxtDevServer(
            $(`<html><head><script>window.__NUXT_DEVTOOLS_TIME_METRIC__ = Date.now();</script></head></html>`),
            "http://localhost:3000"
        );
        expect(result).toBe(true);
    });

    it("detects import.meta.hot in an inline script block", () => {
        const result = isNuxtDevServer(
            $(`<html><head><script>if (import.meta.hot) { import.meta.hot.accept(); }</script></head></html>`),
            "http://localhost:3000"
        );
        expect(result).toBe(true);
    });

    it("detects webpackHotUpdate in an inline script block (Nuxt 2)", () => {
        const result = isNuxtDevServer(
            $(`<html><head><script>window.webpackHotUpdate("app", {});</script></head></html>`),
            "http://localhost:3000"
        );
        expect(result).toBe(true);
    });

    it("detects a /__webpack_hmr pathname (Nuxt 2 webpack-hot-middleware endpoint)", () => {
        const result = isNuxtDevServer(
            $(`<html><head><script src="/__webpack_hmr/client"></script></head></html>`),
            "http://localhost:3000"
        );
        expect(result).toBe(true);
    });

    it("detects an unhashed Nuxt 2 entry filename (_nuxt/app.js)", () => {
        const result = isNuxtDevServer(
            $(`<html><head><script src="/_nuxt/app.js"></script></head></html>`),
            "http://localhost:3000"
        );
        expect(result).toBe(true);
    });

    it("does not detect a dev server from a content-hashed production filename", () => {
        const result = isNuxtDevServer(
            $(`<html><head><script src="/_nuxt/app.8f3a2b1c.js"></script></head></html>`),
            "http://localhost:3000"
        );
        expect(result).toBe(false);
    });

    it("does not detect a plain production Nuxt page with no dev markers", () => {
        const result = isNuxtDevServer(
            $(`<html><head><script src="/_nuxt/entry.8f3a2b1c.js"></script></head></html>`),
            "http://localhost:3000"
        );
        expect(result).toBe(false);
    });

    it("falls back to intercepted URLs when no HTML-level marker is present", () => {
        const result = isNuxtDevServer($(`<html><head></head></html>`), "http://localhost:3000", [
            "http://localhost:3000/_nuxt/@vite/client",
        ]);
        expect(result).toBe(true);
    });

    it("falls back to intercepted URLs for the /__webpack_hmr endpoint", () => {
        const result = isNuxtDevServer($(`<html><head></head></html>`), "http://localhost:3000", [
            "http://localhost:3000/__webpack_hmr/client",
        ]);
        expect(result).toBe(true);
    });

    it("returns false for an empty document with no intercepted URLs", () => {
        const result = isNuxtDevServer($(`<html><head></head></html>`), "http://localhost:3000");
        expect(result).toBe(false);
    });

    it("resolves a relative src against baseUrl before checking the pathname", () => {
        const result = isNuxtDevServer(
            $(`<html><head><script type="module" src="_nuxt/@vite/client"></script></head></html>`),
            "http://localhost:3000/"
        );
        expect(result).toBe(true);
    });
});
