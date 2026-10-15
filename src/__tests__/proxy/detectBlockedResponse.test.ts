import { describe, expect, it, vi } from "vitest";
import {
    detectBlockedResponse,
    type BlockedResponseInput,
    type BlockedResponseResult,
} from "../../proxy/detectBlockedResponse.js";

const response = (overrides: Partial<BlockedResponseInput> = {}): BlockedResponseInput => ({
    status: 200,
    headers: {},
    body: "",
    ...overrides,
});

const expectBlockedBy = (
    result: BlockedResponseResult,
    provider: "cloudflare" | "cloudfront" | "cdn",
    signal: string
): void => {
    expect(result).toMatchObject({ blocked: true, provider });
    expect(result.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ signal })]));
};

describe("detectBlockedResponse", () => {
    it.each(["Just a moment...", "Attention Required! | Cloudflare"])(
        "identifies the Cloudflare challenge title %s",
        (title) => {
            const result = detectBlockedResponse(
                response({
                    headers: { "content-type": "text/html; charset=UTF-8" },
                    body: `<!doctype html><html><head><title>${title}</title></head><body></body></html>`,
                })
            );

            expectBlockedBy(result, "cloudflare", "cloudflare-challenge-title");
            expect(result.reason).toBe("explicit-challenge");
        }
    );

    it("identifies a Cloudflare challenge-platform body", () => {
        const result = detectBlockedResponse(
            response({
                status: 503,
                headers: { "Content-Type": "text/html" },
                body: `<!doctype html><html><head></head><body>
                    <script src="/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1"></script>
                </body></html>`,
            })
        );

        expectBlockedBy(result, "cloudflare", "cloudflare-challenge-body");
        expect(result.reason).toBe("explicit-challenge");
    });

    // Cloudflare JavaScript Detections inject this beacon into every successfully served page.
    const jsdBeaconPage = (beaconPath: string): string => `<!doctype html><html><head><title>Article</title></head>
        <body><a href="/2026/07/22/article/">Read more</a>
        <script>(function(){function c(){var b=a.contentDocument||a.contentWindow.document;if(b){var d=b.createElement('script');d.innerHTML="window.__CF$cv$params={r:'9b8f0c1d2e3f4a5b',t:'MTc2MDU1MDAwMA=='};var a=document.createElement('script');a.src='${beaconPath}';document.getElementsByTagName('head')[0].appendChild(a);";b.getElementsByTagName('head')[0].appendChild(d)}}})();</script>
        </body></html>`;

    it.each([
        "/cdn-cgi/challenge-platform/scripts/jsd/main.js",
        "/cdn-cgi/challenge-platform/h/b/scripts/jsd/e0c90b6a3ed1/main.js",
    ])("does not treat the JavaScript Detections beacon %s on a served page as a challenge", (beaconPath) => {
        const result = detectBlockedResponse(
            response({
                headers: { "content-type": "text/html; charset=UTF-8", "cf-ray": "9b8f0c1d2e3f4a5b-SJC" },
                body: jsdBeaconPage(beaconPath),
            })
        );

        expect(result).toEqual({ blocked: false, provider: null, reason: null, evidence: [] });
    });

    it("still identifies a challenge page that also carries the JavaScript Detections beacon", () => {
        const result = detectBlockedResponse(
            response({
                status: 403,
                headers: { "content-type": "text/html" },
                body: `${jsdBeaconPage("/cdn-cgi/challenge-platform/scripts/jsd/main.js")}
                    <script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1?ray=9b8f0c1d2e3f4a5b"></script>`,
            })
        );

        expectBlockedBy(result, "cloudflare", "cloudflare-challenge-body");
    });

    it("identifies the legacy Cloudflare bot-management verification marker", () => {
        const result = detectBlockedResponse(
            response({
                headers: { "content-type": "text/html" },
                body: '<!doctype html><html><body><form action="/?bm-verify=token"></form></body></html>',
            })
        );

        expectBlockedBy(result, "cloudflare", "cloudflare-challenge-body");
    });

    it("treats the case-insensitive cf-mitigated challenge header as explicit evidence", () => {
        const result = detectBlockedResponse(
            response({
                headers: new Headers({ "CF-Mitigated": "Challenge", "content-type": "text/html" }),
                body: "<!doctype html><html><body>Checking your browser</body></html>",
            })
        );

        expectBlockedBy(result, "cloudflare", "cloudflare-challenge-header");
        expect(result.evidence).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ source: "header", name: "cf-mitigated", value: "Challenge" }),
            ])
        );
    });

    it("identifies the complete CloudFront generated-error document", () => {
        const result = detectBlockedResponse(
            response({
                status: 403,
                headers: { "content-type": "text/html" },
                body: `<!doctype html><html><head>
                    <title>ERROR: The request could not be satisfied</title>
                </head><body>Generated by cloudfront (CloudFront)</body></html>`,
            })
        );

        expectBlockedBy(result, "cloudfront", "cloudfront-generated-error-body");
        expect(result.reason).toBe("generated-error");
    });

    it("identifies a CloudFront-generated error from its explicit response header", () => {
        const result = detectBlockedResponse(
            response({
                status: 502,
                headers: {
                    "X-Cache": "Error from cloudfront",
                    "X-Amz-Cf-Id": "test-request-id",
                },
            })
        );

        expectBlockedBy(result, "cloudfront", "cloudfront-generated-error-header");
        expect(result.reason).toBe("generated-error");
    });

    it.each([
        {
            status: 403,
            headers: { Server: "cloudflare", "CF-Ray": "test-ray-id" },
            body: "<!doctype html><html><head><title>Access denied</title></head><body>Request blocked</body></html>",
            provider: "cloudflare" as const,
        },
        {
            status: 429,
            headers: { Server: "Fastly", "X-Served-By": "cache-dtw-kdtw8210021-DTW" },
            body: "<!doctype html><html><head><title>Too Many Requests</title></head><body>Rate limit exceeded</body></html>",
            provider: "cdn" as const,
        },
        {
            status: 503,
            headers: { Server: "AkamaiGHost" },
            body: "<!doctype html><html><head><title>Service unavailable</title></head><body>Temporarily unavailable</body></html>",
            provider: "cdn" as const,
        },
    ])("identifies a corroborated CDN $status response", ({ status, headers, body, provider }) => {
        const result = detectBlockedResponse(response({ status, headers, body }));

        expectBlockedBy(result, provider, "blocked-http-status");
        expect(result.reason).toBe("corroborated-status");
        expect(result.evidence).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ signal: "cdn-response-header" }),
                expect.objectContaining({ signal: "status-matched-denial-body" }),
            ])
        );
    });

    it.each([
        {
            name: "ordinary 200 HTML",
            input: response({
                headers: { "content-type": "text/html" },
                body: `<!doctype html><html><head><title>CloudFront troubleshooting</title></head>
                    <body>ERROR: The request could not be satisfied. Generated by cloudfront (CloudFront)</body></html>`,
            }),
        },
        {
            name: "ordinary 404 HTML served through a CDN",
            input: response({
                status: 404,
                headers: { Server: "cloudflare", "CF-Ray": "test-ray-id", "content-type": "text/html" },
                body: "<!doctype html><html><head><title>Not Found</title></head><body>Not Found</body></html>",
            }),
        },
        {
            name: "an ordinary CloudFront 404 error response",
            input: response({
                status: 404,
                headers: { "X-Cache": "Error from cloudfront", "content-type": "text/html" },
                body: "<!doctype html><html><head><title>Not Found</title></head><body>Not Found</body></html>",
            }),
        },
        {
            name: "an application JSON 403 served through Cloudflare",
            input: response({
                status: 403,
                headers: {
                    Server: "cloudflare",
                    "CF-Ray": "test-ray-id",
                    "content-type": "application/json",
                },
                body: '{"error":"Forbidden"}',
            }),
        },
        {
            name: "an ordinary application 403 HTML page served through Cloudflare",
            input: response({
                status: 403,
                headers: {
                    Server: "cloudflare",
                    "CF-Ray": "test-ray-id",
                    "content-type": "text/html",
                },
                body: `<!doctype html><html><head><title>403 Forbidden</title></head>
                    <body>You do not have permission to view this page.</body></html>`,
            }),
        },
        {
            name: "valid JavaScript containing copied challenge strings",
            input: response({
                headers: { "content-type": "application/javascript" },
                body: `const samples = [
                    "<title>Just a moment...</title>",
                    "ERROR: The request could not be satisfied. Generated by cloudfront (CloudFront)"
                ];`,
            }),
        },
        {
            name: "a JavaScript syntax error returned by a CDN",
            input: response({
                status: 503,
                headers: { Server: "Fastly", "content-type": "text/plain" },
                body: "SyntaxError: Unexpected token '<' at bundle.js:1:1",
            }),
        },
        {
            name: "a blocked status without CDN evidence",
            input: response({
                status: 403,
                headers: { "content-type": "text/html" },
                body: "<!doctype html><html><head><title>Access denied</title></head><body>Forbidden</body></html>",
            }),
        },
        {
            name: "CDN headers without a matching denial body",
            input: response({
                status: 403,
                headers: { Server: "cloudflare", "CF-Ray": "test-ray-id", "content-type": "text/html" },
                body: "<!doctype html><html><head><title>Account</title></head><body>Signed in</body></html>",
            }),
        },
    ])("does not classify $name as blocking", ({ input }) => {
        expect(detectBlockedResponse(input)).toEqual({
            blocked: false,
            provider: null,
            reason: null,
            evidence: [],
        });
    });

    it("is silent and returns immutable structured evidence", () => {
        const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

        const result = detectBlockedResponse(
            response({
                headers: { "cf-mitigated": "challenge" },
                body: "<!doctype html><html><body>Challenge</body></html>",
            })
        );

        expect(log).not.toHaveBeenCalled();
        expect(warn).not.toHaveBeenCalled();
        expect(error).not.toHaveBeenCalled();
        expect(Object.isFrozen(result)).toBe(true);
        expect(Object.isFrozen(result.evidence)).toBe(true);
        expect(result.evidence.every(Object.isFrozen)).toBe(true);

        vi.restoreAllMocks();
    });
});
