import { describe, it, expect } from "vitest";
import * as cheerio from "cheerio";
import { isVueDevServer } from "../../lazyLoad/techDetect/checkVueDevServer.js";

const $ = (html: string) => cheerio.load(html);

describe("isVueDevServer", () => {
    it("detects the Vite client script by pathname", () => {
        const result = isVueDevServer(
            $(`<html><head><script type="module" src="/@vite/client"></script></head></html>`),
            "http://localhost:5173"
        );
        expect(result).toBe(true);
    });

    it("detects the Vite client script even with a query string appended", () => {
        const result = isVueDevServer(
            $(`<html><head><script type="module" src="/@vite/client?t=123"></script></head></html>`),
            "http://localhost:5173"
        );
        expect(result).toBe(true);
    });

    it("does not false-positive on a query string that merely contains @vite/client", () => {
        const result = isVueDevServer(
            $(`<html><head><script src="/assets/main.js?ref=/@vite/client"></script></head></html>`),
            "http://localhost:5173"
        );
        expect(result).toBe(false);
    });

    it("detects import.meta.hot in an inline script block", () => {
        const result = isVueDevServer(
            $(`<html><head><script>if (import.meta.hot) { import.meta.hot.accept(); }</script></head></html>`),
            "http://localhost:5173"
        );
        expect(result).toBe(true);
    });

    it("detects webpackHotUpdate in an inline script block", () => {
        const result = isVueDevServer(
            $(`<html><head><script>window.webpackHotUpdate("app", {});</script></head></html>`),
            "http://localhost:8080"
        );
        expect(result).toBe(true);
    });

    it("detects a /sockjs-node/ HMR websocket path", () => {
        const result = isVueDevServer(
            $(`<html><head><script src="/sockjs-node/info?t=123"></script></head></html>`),
            "http://localhost:8080"
        );
        expect(result).toBe(true);
    });

    it("detects an unhashed webpack entry filename (app.js)", () => {
        const result = isVueDevServer(
            $(`<html><head><script src="/js/app.js"></script></head></html>`),
            "http://localhost:8080"
        );
        expect(result).toBe(true);
    });

    it("does not detect a dev server from a content-hashed production filename", () => {
        const result = isVueDevServer(
            $(`<html><head><script src="/js/app.8f3a2b1c.js"></script></head></html>`),
            "http://localhost:8080"
        );
        expect(result).toBe(false);
    });

    it("falls back to intercepted URLs when no HTML-level marker is present", () => {
        const result = isVueDevServer($(`<html><head></head></html>`), "http://localhost:5173", [
            "http://localhost:5173/@vite/client",
        ]);
        expect(result).toBe(true);
    });

    it("returns false for an empty document with no intercepted URLs", () => {
        const result = isVueDevServer($(`<html><head></head></html>`), "http://localhost:5173");
        expect(result).toBe(false);
    });

    it("resolves a relative src against baseUrl before checking the pathname", () => {
        const result = isVueDevServer(
            $(`<html><head><script type="module" src="@vite/client"></script></head></html>`),
            "http://localhost:5173/"
        );
        expect(result).toBe(true);
    });
});
