import { describe, it, expect } from "vitest";
import * as cheerio from "cheerio";
import { isNextDevServer } from "../../lazyLoad/techDetect/checkNextDevServer.js";

const $ = (html: string) => cheerio.load(html);

describe("isNextDevServer", () => {
    it("detects a node_modules_ dev chunk in a script src", () => {
        const result = isNextDevServer(
            $(
                `<html><head><script src="/_next/static/chunks/node_modules_next_dist_445d8acf._.js"></script></head></html>`
            ),
            "http://localhost:3000"
        );
        expect(result).toBe(true);
    });

    it("detects a ._.js-suffixed chunk via the pathname, ignoring query strings", () => {
        const result = isNextDevServer(
            $(`<html><head><script src="/_next/static/chunks/_01f48b92._.js?v=123"></script></head></html>`),
            "http://localhost:3000"
        );
        expect(result).toBe(true);
    });

    it("does not false-positive on a query/fragment that merely contains ._.js", () => {
        const result = isNextDevServer(
            $(`<html><head><script src="/_next/static/chunks/main.js?src=foo._.js"></script></head></html>`),
            "http://localhost:3000"
        );
        expect(result).toBe(false);
    });

    it("does not detect a dev server from production chunk naming", () => {
        const result = isNextDevServer(
            $(`<html><head><script src="/_next/static/chunks/main-8f3a2b1c.js"></script></head></html>`),
            "http://localhost:3000"
        );
        expect(result).toBe(false);
    });

    it("falls back to intercepted URLs when no HTML-level marker is present", () => {
        const result = isNextDevServer($(`<html><head></head></html>`), "http://localhost:3000", [
            "http://localhost:3000/_next/static/chunks/node_modules_react-dom_1f56dc06._.js",
        ]);
        expect(result).toBe(true);
    });

    it("returns false for an empty document with no intercepted URLs", () => {
        const result = isNextDevServer($(`<html><head></head></html>`), "http://localhost:3000");
        expect(result).toBe(false);
    });

    it("resolves a relative src against baseUrl before checking the pathname", () => {
        const result = isNextDevServer(
            $(`<html><head><script src="_next/static/chunks/foo._.js"></script></head></html>`),
            "http://localhost:3000/app/page"
        );
        expect(result).toBe(true);
    });
});
