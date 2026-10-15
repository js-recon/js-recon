import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({ makeRequest: vi.fn() }));

vi.mock("../../utility/makeReq.js", () => ({ default: harness.makeRequest }));

import generic_getScriptTags from "../../lazyLoad/generic/generic_getScriptTags.js";
import generic_downloadFiles from "../../lazyLoad/generic/generic_downloadFiles.js";

const CHALLENGE_HTML =
    '<!doctype html><html><head><title>Just a moment...</title><script src="/s/challenge.js"></script></head><body><script>window._cf_chl_opt = {};</script></body></html>';
const challengeResponse = (): Response =>
    new Response(CHALLENGE_HTML, { headers: { server: "cloudflare", "content-type": "text/html" } });

let outputDir: string;

const listFiles = (dir: string): string[] =>
    fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true, encoding: "utf-8" }) : [];

beforeEach(() => {
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "js-recon-generic-challenge-"));
    harness.makeRequest.mockReset();
});

afterEach(() => {
    fs.rmSync(outputDir, { recursive: true, force: true });
});

describe("generic_getScriptTags", () => {
    it("takes nothing from a page that is still a CDN/WAF challenge", async () => {
        harness.makeRequest.mockResolvedValue(challengeResponse());

        const result = await generic_getScriptTags("https://blocked.example.test/", 2, outputDir);

        expect(result).toEqual({ urls: [], pageSource: "", pageUrl: "https://blocked.example.test/" });
        expect(listFiles(outputDir)).toEqual([]);
    });
});

describe("generic_downloadFiles", () => {
    it("saves scripts and never saves a challenge page as a .js file", async () => {
        harness.makeRequest.mockImplementation(async (url: string) =>
            url.endsWith("/a.js")
                ? challengeResponse()
                : new Response("console.log('b');", { headers: { "content-type": "application/javascript" } })
        );

        await generic_downloadFiles(["https://example.test/s/a.js", "https://example.test/s/b.js"], outputDir, 1);

        const files = listFiles(outputDir).filter((file) => file.endsWith(".js"));
        expect(files).toEqual([path.join("example.test", "s", "b.js")]);
        expect(fs.readFileSync(path.join(outputDir, files[0]), "utf-8")).toBe(
            "// File Source: https://example.test/s/b.js\nconsole.log('b');"
        );
    });
});
