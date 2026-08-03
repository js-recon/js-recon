import { afterEach, describe, expect, it, vi } from "vitest";
import checkFireWallBlocking from "../../proxy/checkFireWallBlocking.js";

describe("checkFireWallBlocking", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("returns false for a plain 200 response with no context", async () => {
        await expect(checkFireWallBlocking("<html><body>ok</body></html>")).resolves.toBe(false);
    });

    it("detects a Cloudflare challenge title even with no status/headers context", async () => {
        const body = `<!doctype html><html><head><title>Just a moment...</title></head><body></body></html>`;
        await expect(checkFireWallBlocking(body)).resolves.toBe(true);
    });

    // Regression for internal-docs#129: checkFireWallBlocking used to hardcode `status: 503`
    // and never pass headers, so a real 403 "Access Denied" WAF/CDN block corroborated by a
    // real cf-ray header was silently missed. This is the exact repro from that issue, run
    // through the actual exported checkFireWallBlocking rather than detectBlockedResponse directly.
    it("detects a 403 CDN-header-corroborated Access Denied page when real status/headers are passed", async () => {
        const body = `<!doctype html><html><head><title>Access Denied</title></head><body>Access Denied - you don't have permission to access this resource.</body></html>`;
        const result = await checkFireWallBlocking(body, {
            status: 403,
            headers: { "cf-ray": "8a1b2c3d4e5f6789-SJC", "content-type": "text/html" },
        });
        expect(result).toBe(true);
    });

    it("does not spoof corroborated-status detection when status/headers are genuinely unavailable", async () => {
        const body = `<!doctype html><html><head><title>Access Denied</title></head><body>Access Denied</body></html>`;
        await expect(checkFireWallBlocking(body)).resolves.toBe(false);
    });

    it("logs the detected provider to stderr", async () => {
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
        await checkFireWallBlocking(`<!doctype html><html><head><title>Just a moment...</title></head></html>`);
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Cloudflare/CDN detected"));
    });
});
