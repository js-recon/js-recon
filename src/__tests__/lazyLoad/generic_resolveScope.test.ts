import { describe, it, expect } from "vitest";
import { hostFromUrl, resolveRedirectChain } from "../../lazyLoad/generic/generic_resolveScope.js";

describe("hostFromUrl", () => {
    it("extracts the host from a plain URL", () => {
        expect(hostFromUrl("https://example.com/some/path")).toBe("example.com");
    });

    it("includes a non-default port", () => {
        expect(hostFromUrl("https://example.com:8443/path")).toBe("example.com:8443");
    });
});

describe("resolveRedirectChain", () => {
    const makeFetch = (responses: Record<string, { status: number; location?: string }>) => {
        return (async (url: string) => {
            const r = responses[url];
            if (!r) throw new Error(`unexpected url ${url}`);
            return {
                status: r.status,
                headers: {
                    get: (name: string) => (name.toLowerCase() === "location" ? (r.location ?? null) : null),
                },
            } as unknown as Response;
        }) as typeof fetch;
    };

    it("returns the start URL when there is no redirect", async () => {
        const fetchImpl = makeFetch({ "https://example.com/": { status: 200 } });
        const result = await resolveRedirectChain("https://example.com/", 20, fetchImpl);
        expect(result).toBe("https://example.com/");
    });

    it("follows a single redirect to an absolute location", async () => {
        const fetchImpl = makeFetch({
            "https://example.com/": { status: 301, location: "https://www.example.com/" },
            "https://www.example.com/": { status: 200 },
        });
        const result = await resolveRedirectChain("https://example.com/", 20, fetchImpl);
        expect(result).toBe("https://www.example.com/");
    });

    it("resolves a relative Location header against the current URL", async () => {
        const fetchImpl = makeFetch({
            "https://example.com/old": { status: 302, location: "/new" },
            "https://example.com/new": { status: 200 },
        });
        const result = await resolveRedirectChain("https://example.com/old", 20, fetchImpl);
        expect(result).toBe("https://example.com/new");
    });

    it("stops after maxRedirects hops even if more redirects remain", async () => {
        const fetchImpl = (async (url: string) => {
            const n = Number(url.split("/").pop());
            return {
                status: 302,
                headers: { get: () => `https://example.com/${n + 1}` },
            } as unknown as Response;
        }) as typeof fetch;

        const result = await resolveRedirectChain("https://example.com/0", 3, fetchImpl);
        expect(result).toBe("https://example.com/3");
    });

    it("returns the current URL when a redirect has no Location header", async () => {
        const fetchImpl = makeFetch({ "https://example.com/": { status: 302 } });
        const result = await resolveRedirectChain("https://example.com/", 20, fetchImpl);
        expect(result).toBe("https://example.com/");
    });

    it("returns the current URL when the fetch throws", async () => {
        const fetchImpl = (async () => {
            throw new Error("network error");
        }) as unknown as typeof fetch;
        const result = await resolveRedirectChain("https://example.com/", 20, fetchImpl);
        expect(result).toBe("https://example.com/");
    });
});
