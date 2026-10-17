import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({ makeRequest: vi.fn() }));

vi.mock("../../utility/makeReq.js", () => ({ default: harness.makeRequest }));
vi.mock("../../lazyLoad/react/react_followImports.js", () => ({ default: vi.fn(async () => []) }));

import svelte_recursivePageCrawl, { extractPageLinks } from "../../lazyLoad/svelte/svelte_recursivePageCrawl.js";
import { withResponseUrl } from "../../utility/responseUrl.js";

/** An HTML page served from `servedUrl`, as makeRequest returns it after following redirects. */
const page = (servedUrl: string, body: string): Response =>
    withResponseUrl(new Response(body, { headers: { "content-type": "text/html" } }), servedUrl);

beforeEach(() => {
    harness.makeRequest.mockReset();
});

describe("extractPageLinks", () => {
    it("resolves links against the served page and keeps only the allowed origins", () => {
        const links = extractPageLinks(
            "https://www.example.test/docs/",
            '<a href="intro">Intro</a><a href="/about#team">About</a><a href="https://elsewhere.test/x">X</a>',
            new Set(["https://www.example.test"])
        );

        expect(links).toEqual(["https://www.example.test/docs/intro", "https://www.example.test/about"]);
    });
});

describe("svelte_recursivePageCrawl", () => {
    it("never crawls an origin a page redirects to, such as an SSO provider", async () => {
        const pages: Record<string, () => Response> = {
            "https://target.test/": () =>
                page("https://target.test/", '<a href="/about">About</a><a href="/login">Log in</a>'),
            "https://target.test/about": () =>
                page("https://target.test/about", '<script src="/_app/about.js"></script><a href="/team">Team</a>'),
            "https://target.test/login": () =>
                page(
                    "https://sso.example.org/login",
                    '<script src="/sso.js"></script><a href="/help">Help</a><a href="/register">Register</a>'
                ),
            "https://target.test/team": () => page("https://target.test/team", "<p>team</p>"),
        };
        harness.makeRequest.mockImplementation(async (url: string) => pages[url]?.() ?? null);

        const jsFiles = await svelte_recursivePageCrawl("https://target.test/");

        const requested = harness.makeRequest.mock.calls.map(([url]) => url);
        expect(requested.every((url: string) => url.startsWith("https://target.test/"))).toBe(true);
        expect(requested).toContain("https://target.test/team");
        expect(jsFiles).toEqual(["https://target.test/_app/about.js"]);
    });

    it("follows the entry's own redirect, for example from the apex to www", async () => {
        const pages: Record<string, () => Response> = {
            "https://example.test/": () => page("https://www.example.test/", '<a href="/docs">Docs</a>'),
            "https://www.example.test/docs": () =>
                page("https://www.example.test/docs", '<script src="/_app/docs.js"></script>'),
        };
        harness.makeRequest.mockImplementation(async (url: string) => pages[url]?.() ?? null);

        const jsFiles = await svelte_recursivePageCrawl("https://example.test/");

        expect(harness.makeRequest).toHaveBeenCalledWith("https://www.example.test/docs", {});
        expect(jsFiles).toEqual(["https://www.example.test/_app/docs.js"]);
    });
});
