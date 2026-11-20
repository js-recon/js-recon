import { describe, expect, it } from "vitest";
import * as cheerio from "cheerio";
import { isGlobalBuildOnly } from "../../lazyLoad/techDetect/isGlobalBuildOnly.js";

const page = (head: string) => cheerio.load(`<html><head>${head}</head><body></body></html>`);

describe("isGlobalBuildOnly", () => {
    it("is true for UMD React dev builds loaded with plain script tags", () => {
        expect(
            isGlobalBuildOnly(
                page(
                    `<script src="/js/react.development.js"></script><script src="/js/react-dom.development.js"></script><script>var x = 1;</script>`
                )
            )
        ).toBe(true);
    });

    it("is true for a CDN UMD React build and for Vue global builds", () => {
        expect(
            isGlobalBuildOnly(
                page(`<script src="https://cdn.example.test/react@18/umd/react.production.min.js"></script>`)
            )
        ).toBe(true);
        expect(
            isGlobalBuildOnly(page(`<script src="https://cdn.example.test/vue@3/dist/vue.global.prod.js"></script>`))
        ).toBe(true);
        expect(isGlobalBuildOnly(page(`<script src="/js/vue.min.js"></script>`))).toBe(true);
    });

    it("is false when the page also has ES-module scripts or modulepreload", () => {
        expect(
            isGlobalBuildOnly(
                page(`<script src="/react.development.js"></script><script type="module" src="/app.js"></script>`)
            )
        ).toBe(false);
        expect(
            isGlobalBuildOnly(
                page(`<script src="/vue.global.js"></script><link rel="modulepreload" href="/assets/vendor-abc.js">`)
            )
        ).toBe(false);
    });

    it("is false when an inline script carries a webpack runtime", () => {
        expect(
            isGlobalBuildOnly(
                page(
                    `<script src="/react.production.min.js"></script><script>(self.webpackChunkapp=self.webpackChunkapp||[]).push([])</script>`
                )
            )
        ).toBe(false);
    });

    it("is false for bundled apps without a global-build file", () => {
        expect(isGlobalBuildOnly(page(`<script defer src="/static/js/main.3f2a1b.js"></script>`))).toBe(false);
        expect(isGlobalBuildOnly(page(`<script src="/assets/react-vendor-1a2b.js"></script>`))).toBe(false);
    });
});
