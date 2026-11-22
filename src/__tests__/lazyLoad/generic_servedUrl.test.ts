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

    it("saves event-handler and javascript: attribute scripts as <attr>-N.js", async () => {
        harness.makeRequest.mockResolvedValue(
            new Response(
                `<script>window.a = 1;</script>
                <img src="x.png" onerror="alert(1)">
                <button onclick="go(&quot;one&quot;)"></button>
                <button OnClick="go(2)"></button>
                <div onclick="go(2)"></div>
                <a href="javascript:foo(%22bar%22)">x</a>
                <svg><a xlink:href=" java&#x09;script:baz()"></a></svg>
                <body onpagereveal="init()"></body>
                <a href="/plain">y</a>`
            )
        );

        await generic_getScriptTags("https://example.test/", 2, outputDir);

        const dir = path.join(outputDir, "example.test");
        const read = (f: string) => fs.readFileSync(path.join(dir, f), "utf-8");
        expect(fs.readdirSync(dir).sort()).toEqual([
            "inline-0.js",
            "javascript-1.js",
            "javascript-2.js",
            "onclick-1.js",
            "onclick-2.js",
            "onerror-1.js",
            "onpagereveal-1.js",
        ]);
        expect(read("javascript-2.js").split("\n")[1]).toBe("baz()");
        expect(read("onerror-1.js")).toBe(
            "// File Source: https://example.test/ (onerror attribute #1 on <img>)\nalert(1)"
        );
        expect(read("onclick-1.js").split("\n")[1]).toBe('go("one")');
        expect(read("onclick-2.js").split("\n")[1]).toBe("go(2)");
        expect(read("javascript-1.js").split("\n")[1]).toBe('foo("bar")');
    });

    it("doesn't overwrite scripts from pages that differ only by query string", async () => {
        harness.makeRequest.mockResolvedValueOnce(new Response(`<script>a()</script><a onclick="x()">`));
        harness.makeRequest.mockResolvedValueOnce(new Response(`<script>b()</script><a onclick="x()">`));

        await generic_getScriptTags("https://example.test/post?id=1", 2, outputDir);
        await generic_getScriptTags("https://example.test/post?id=2", 2, outputDir);

        const dir = path.join(outputDir, "example.test", "post");
        expect(fs.readdirSync(dir).sort()).toEqual(["inline-0.js", "inline-1.js", "onclick-1.js"]);
        expect(fs.readFileSync(path.join(dir, "inline-1.js"), "utf-8")).toBe(
            "// File Source: https://example.test/post?id=2 (inline script #1)\nb()"
        );
    });

    it("keeps the requested URL as the base when the response has no final URL", async () => {
        harness.makeRequest.mockResolvedValue(new Response('<script src="js/app.js"></script>'));

        const result = await generic_getScriptTags("https://example.test/docs/", 2, outputDir);

        expect(result.pageUrl).toBe("https://example.test/docs/");
        expect(result.urls).toEqual(["https://example.test/docs/js/app.js"]);
    });
});
