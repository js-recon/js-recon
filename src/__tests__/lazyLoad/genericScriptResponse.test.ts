import { describe, expect, it } from "vitest";
import { readGenericScriptResponse } from "../../lazyLoad/downloadResponse.js";

const CHALLENGE_HTML =
    '<!doctype html><html><head><title>Just a moment...</title></head><body><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script></body></html>';

describe("readGenericScriptResponse", () => {
    it("accepts a script", async () => {
        const result = await readGenericScriptResponse(
            new Response("fetch('/api/v1/users');", { headers: { "content-type": "application/javascript" } })
        );

        expect(result).toEqual({ ok: true, body: "fetch('/api/v1/users');" });
    });

    it("accepts a script a server mislabels as text/html", async () => {
        const result = await readGenericScriptResponse(
            new Response("window.app = {};", { headers: { "content-type": "text/html" } })
        );

        expect(result).toEqual({ ok: true, body: "window.app = {};" });
    });

    it("rejects a non-2xx response", async () => {
        const result = await readGenericScriptResponse(
            new Response("missing", { status: 404, statusText: "Not Found" })
        );

        expect(result).toEqual({ ok: false, failure: "invalidResponse", reason: "HTTP 404 Not Found" });
    });

    it("rejects a CDN/WAF challenge served with status 200", async () => {
        const result = await readGenericScriptResponse(
            new Response(CHALLENGE_HTML, { headers: { server: "cloudflare", "content-type": "text/html" } })
        );

        expect(result).toMatchObject({
            ok: false,
            failure: "invalidResponse",
            reason: expect.stringContaining("CDN/WAF"),
        });
    });

    it("rejects a challenge flagged only by the cf-mitigated header", async () => {
        const result = await readGenericScriptResponse(
            new Response("var token = 1;", { headers: { "cf-mitigated": "challenge" } })
        );

        expect(result).toMatchObject({ ok: false, failure: "invalidResponse" });
    });

    it("rejects an HTML document such as an SPA fallback or a homepage redirect", async () => {
        const result = await readGenericScriptResponse(
            new Response("<!doctype html><html><head><title>Home</title></head></html>", {
                headers: { "content-type": "text/html" },
            })
        );

        expect(result).toMatchObject({
            ok: false,
            failure: "invalidResponse",
            reason: expect.stringContaining("HTML"),
        });
    });
});
