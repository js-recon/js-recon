import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({ makeRequest: vi.fn() }));

vi.mock("../../utility/makeReq.js", () => ({ default: harness.makeRequest }));

import generic_getScriptTags from "../../lazyLoad/generic/generic_getScriptTags.js";
import { withResponseUrl } from "../../utility/responseUrl.js";

let outputDir: string;

beforeEach(() => {
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "js-recon-generic-served-url-"));
    harness.makeRequest.mockReset();
});

afterEach(() => {
    fs.rmSync(outputDir, { recursive: true, force: true });
});

describe("generic_getScriptTags", () => {
    it("resolves relative script paths against the page a redirect led to", async () => {
        harness.makeRequest.mockResolvedValue(
            withResponseUrl(
                new Response(
                    `<!doctype html><html><head>
                        <script src="js/app.js"></script>
                        <script src="/static/vendor.js"></script>
                        <link rel="modulepreload" href="chunk.js">
                    </head><body><script>window.inline = true;</script></body></html>`,
                    { headers: { "content-type": "text/html" } }
                ),
                "https://www.example.test/site/"
            )
        );

        const result = await generic_getScriptTags("https://example.test/", 2, outputDir);

        expect(result.pageUrl).toBe("https://www.example.test/site/");
        expect(result.urls).toEqual([
            "https://www.example.test/site/js/app.js",
            "https://www.example.test/static/vendor.js",
            "https://www.example.test/site/chunk.js",
        ]);
        // Inline scripts keep the requested target's directory but name their real source.
        const inline = fs.readFileSync(path.join(outputDir, "example.test", "inline-0.js"), "utf-8");
        expect(inline.split("\n")[0]).toBe("// File Source: https://www.example.test/site/ (inline script #0)");
    });

    it("keeps the requested URL as the base when the response has no final URL", async () => {
        harness.makeRequest.mockResolvedValue(new Response('<script src="js/app.js"></script>'));

        const result = await generic_getScriptTags("https://example.test/docs/", 2, outputDir);

        expect(result.pageUrl).toBe("https://example.test/docs/");
        expect(result.urls).toEqual(["https://example.test/docs/js/app.js"]);
    });
});
