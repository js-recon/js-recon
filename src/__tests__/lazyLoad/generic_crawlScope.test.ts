import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({ makeRequest: vi.fn() }));

vi.mock("../../utility/makeReq.js", () => ({ default: harness.makeRequest, isRequestCancelled: () => false }));

import generic_crawlPages from "../../lazyLoad/generic/generic_crawlPages.js";
import * as lazyLoadGlobals from "../../lazyLoad/globals.js";
import { withResponseUrl } from "../../utility/responseUrl.js";

/** An HTML page served from `servedUrl`, as makeRequest returns it after following redirects. */
const page = (servedUrl: string, body: string): Response =>
    withResponseUrl(new Response(body, { headers: { "content-type": "text/html" } }), servedUrl);

let outputDir: string;

beforeEach(() => {
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "js-recon-generic-scope-"));
    harness.makeRequest.mockReset();
    lazyLoadGlobals.setScope(["target.test"]);
});

afterEach(() => {
    lazyLoadGlobals.setScope(["*"]);
    fs.rmSync(outputDir, { recursive: true, force: true });
});

describe("generic_crawlPages", () => {
    it("takes nothing from a linked page that redirects out of scope", async () => {
        const responses: Record<string, () => Response> = {
            "https://target.test/": () =>
                page("https://target.test/", '<a href="https://target.test/login">Log in</a>'),
            "https://target.test/login": () =>
                page("https://sso.example.org/login", '<script src="/sso.js"></script><a href="/help">Help</a>'),
        };
        harness.makeRequest.mockImplementation(async (url: string) => responses[url]?.() ?? null);

        await generic_crawlPages("https://target.test/", 2, outputDir, 200, 1);

        const requested = harness.makeRequest.mock.calls.map(([url]) => url);
        expect(requested.filter((url: string) => url.includes("sso.example.org"))).toEqual([]);
    });
});
