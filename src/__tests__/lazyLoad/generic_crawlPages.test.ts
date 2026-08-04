import { describe, it, expect } from "vitest";
import { isInScope } from "../../lazyLoad/generic/generic_crawlPages.js";

describe("isInScope", () => {
    it("allows any host when scope is the wildcard", () => {
        expect(isInScope("https://anything.example", ["*"])).toBe(true);
    });

    it("allows a URL whose host is in the scope list", () => {
        expect(isInScope("https://example.com/page", ["example.com"])).toBe(true);
    });

    it("rejects a URL whose host is not in the scope list", () => {
        expect(isInScope("https://evil.example/page", ["example.com"])).toBe(false);
    });

    it("matches host including a non-default port", () => {
        expect(isInScope("https://example.com:8443/page", ["example.com:8443"])).toBe(true);
        expect(isInScope("https://example.com:8443/page", ["example.com"])).toBe(false);
    });

    it("returns false for an unparseable URL", () => {
        expect(isInScope("not a url", ["example.com"])).toBe(false);
    });
});
