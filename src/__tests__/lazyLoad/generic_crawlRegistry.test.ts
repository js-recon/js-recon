import { describe, expect, it } from "vitest";
import { GenericCrawlRegistry, crawlStartKey } from "../../lazyLoad/generic/generic_crawlRegistry.js";

describe("crawlStartKey", () => {
    it("keeps origin and path and drops query and fragment", () => {
        expect(crawlStartKey("https://WWW.Example.com/start/?utm=1#top")).toBe("https://www.example.com/start/");
    });

    it("distinguishes schemes, ports and paths", () => {
        expect(crawlStartKey("http://example.com/")).not.toBe(crawlStartKey("https://example.com/"));
        expect(crawlStartKey("https://example.com:8443/")).not.toBe(crawlStartKey("https://example.com/"));
        expect(crawlStartKey("https://example.com/a")).not.toBe(crawlStartKey("https://example.com/b"));
    });

    it("returns an unparsable URL unchanged", () => {
        expect(crawlStartKey("not a url")).toBe("not a url");
    });
});

describe("GenericCrawlRegistry", () => {
    it("lets the first target that reaches a start page crawl it", () => {
        const registry = new GenericCrawlRegistry();

        expect(registry.claim("https://www.example.com/", "https://a.example.com")).toBeNull();
    });

    it("reports the earlier target when another target redirects to the same start page", () => {
        const registry = new GenericCrawlRegistry();
        registry.claim("https://www.example.com/", "https://a.example.com");

        expect(registry.claim("https://www.example.com/?ref=b", "http://b.example.com")).toBe("https://a.example.com");
    });

    it("never treats a repeat of the same target as a duplicate", () => {
        const registry = new GenericCrawlRegistry();
        registry.claim("https://www.example.com/", "https://a.example.com");

        expect(registry.claim("https://www.example.com/", "https://a.example.com")).toBeNull();
    });

    it("lets targets with different start pages crawl", () => {
        const registry = new GenericCrawlRegistry();
        registry.claim("https://www.example.com/", "https://a.example.com");

        expect(registry.claim("https://shop.example.com/", "https://shop.example.com")).toBeNull();
    });

    it("forgets every start page on reset", () => {
        const registry = new GenericCrawlRegistry();
        registry.claim("https://www.example.com/", "https://a.example.com");
        registry.reset();

        expect(registry.claim("https://www.example.com/", "https://b.example.com")).toBeNull();
    });
});
