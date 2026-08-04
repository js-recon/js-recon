import { describe, it, expect } from "vitest";
import { extractPageLinks, extractEmbeddedUrls } from "../../lazyLoad/generic/generic_extractLinks.js";

describe("extractPageLinks", () => {
    it("resolves a relative link against the base URL", () => {
        const html = `<a href="/about">About</a>`;
        const result = extractPageLinks(html, "https://example.com");
        expect(result).toEqual(["https://example.com/about"]);
    });

    it("keeps absolute http(s) links unchanged", () => {
        const html = `<a href="https://example.com/contact">Contact</a>`;
        const result = extractPageLinks(html, "https://example.com");
        expect(result).toEqual(["https://example.com/contact"]);
    });

    it("ignores fragment-only links", () => {
        const html = `<a href="#top">Top</a>`;
        const result = extractPageLinks(html, "https://example.com");
        expect(result).toEqual([]);
    });

    it("strips the hash from a link with a path and a fragment", () => {
        const html = `<a href="/about#team">About</a>`;
        const result = extractPageLinks(html, "https://example.com");
        expect(result).toEqual(["https://example.com/about"]);
    });

    it("ignores mailto, tel, javascript, data, and blob links", () => {
        const html = `
            <a href="mailto:test@example.com">Mail</a>
            <a href="tel:+15551234567">Call</a>
            <a href="javascript:void(0)">JS</a>
            <a href="data:text/plain,hello">Data</a>
            <a href="blob:https://example.com/uuid">Blob</a>
        `;
        expect(extractPageLinks(html, "https://example.com")).toEqual([]);
    });

    it("does not throw on unparseable href values and excludes them", () => {
        const html = `<a href="http://[::1">bad</a>`;
        expect(() => extractPageLinks(html, "https://example.com")).not.toThrow();
        expect(extractPageLinks(html, "https://example.com")).toEqual([]);
    });

    it("dedupes repeated links", () => {
        const html = `<a href="/a">one</a><a href="/a">two</a>`;
        const result = extractPageLinks(html, "https://example.com");
        expect(result).toEqual(["https://example.com/a"]);
    });

    it("ignores links with no href attribute", () => {
        const html = `<a name="anchor">no href</a>`;
        expect(extractPageLinks(html, "https://example.com")).toEqual([]);
    });

    it("resolves an iframe src as a page link", () => {
        const html = `<iframe src="/widgets/player?id=123"></iframe>`;
        const result = extractPageLinks(html, "https://example.com");
        expect(result).toEqual(["https://example.com/widgets/player?id=123"]);
    });

    it("combines a href and iframe src results, deduped", () => {
        const html = `<a href="/page">link</a><iframe src="/page"></iframe><iframe src="/other"></iframe>`;
        const result = extractPageLinks(html, "https://example.com").sort();
        expect(result).toEqual(["https://example.com/other", "https://example.com/page"]);
    });

    it("ignores an iframe with no src attribute", () => {
        const html = `<iframe></iframe>`;
        expect(extractPageLinks(html, "https://example.com")).toEqual([]);
    });

    it("extracts a URL passed to a helper function inside an onclick handler", () => {
        // Mirrors WordPress's PowerPress plugin pop-out player link pattern.
        const html = `<a href="https://example.com/audio.mp3" onclick="return powerpress_pinw('https://example.com/?powerpress_pinw=123-podcast');">Play</a>`;
        const result = extractPageLinks(html, "https://example.com").sort();
        expect(result).toEqual(["https://example.com/?powerpress_pinw=123-podcast", "https://example.com/audio.mp3"]);
    });

    it("extracts a URL passed directly to window.open in an onclick handler", () => {
        const html = `<button onclick="window.open('https://example.com/popup', 'name', 'toolbar=0')">Open</button>`;
        const result = extractPageLinks(html, "https://example.com");
        expect(result).toEqual(["https://example.com/popup"]);
    });

    it("does not double-count href/src values also present as embedded URLs elsewhere", () => {
        const html = `<a href="/page" data-track="https://example.com/page">link</a>`;
        const result = extractPageLinks(html, "https://example.com");
        expect(result).toEqual(["https://example.com/page"]);
    });
});

describe("extractEmbeddedUrls", () => {
    it("extracts a single embedded URL", () => {
        expect(extractEmbeddedUrls("return foo('https://example.com/a')")).toEqual(["https://example.com/a"]);
    });

    it("extracts multiple embedded URLs", () => {
        const result = extractEmbeddedUrls("https://example.com/a and https://example.com/b");
        expect(result).toEqual(["https://example.com/a", "https://example.com/b"]);
    });

    it("returns an empty array when there is no embedded URL", () => {
        expect(extractEmbeddedUrls("no urls here")).toEqual([]);
    });

    it("stops at a closing paren so it doesn't swallow trailing JS syntax", () => {
        expect(extractEmbeddedUrls("open('https://example.com/a')")).toEqual(["https://example.com/a"]);
    });
});
