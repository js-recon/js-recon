import { describe, expect, it } from "vitest";
import { responseBaseUrl, withResponseUrl } from "../../utility/responseUrl.js";

describe("withResponseUrl", () => {
    it("sets the URL a constructed Response otherwise lacks", () => {
        const response = withResponseUrl(new Response("body"), "https://www.example.com/landing/");

        expect(response.url).toBe("https://www.example.com/landing/");
    });

    it("leaves the Response unchanged when the final URL is unknown", () => {
        expect(withResponseUrl(new Response("body"), undefined).url).toBe("");
        expect(withResponseUrl(new Response("body"), "").url).toBe("");
    });
});

describe("responseBaseUrl", () => {
    it("prefers the URL the page was served from", () => {
        const response = withResponseUrl(new Response("body"), "https://www.example.com/landing/");

        expect(responseBaseUrl(response, "https://example.com/")).toBe("https://www.example.com/landing/");
    });

    it("falls back to the requested URL", () => {
        expect(responseBaseUrl(new Response("body"), "https://example.com/")).toBe("https://example.com/");
        expect(responseBaseUrl(null, "https://example.com/")).toBe("https://example.com/");
    });
});
