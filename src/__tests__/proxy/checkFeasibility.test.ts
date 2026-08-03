import { afterEach, describe, it, expect, vi } from "vitest";
import { determineFeasibilityOutcome, probeFeasibility } from "../../proxy/checkFeasibility.js";

describe("determineFeasibilityOutcome", () => {
    it("returns code 27 when no firewall is detected without a proxy", () => {
        const outcome = determineFeasibilityOutcome(false, false);
        expect(outcome.code).toBe(27);
    });

    it("returns code 27 regardless of the with-proxy result when unblocked without a proxy", () => {
        const outcome = determineFeasibilityOutcome(false, true);
        expect(outcome.code).toBe(27);
    });

    it("returns code 28 when the firewall is detected both without and with the proxy", () => {
        const outcome = determineFeasibilityOutcome(true, true);
        expect(outcome.code).toBe(28);
    });

    it("returns code 0 when the firewall is detected without the proxy but bypassed with it", () => {
        const outcome = determineFeasibilityOutcome(true, false);
        expect(outcome.code).toBe(0);
    });
});

describe("probeFeasibility", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    // Regression for internal-docs#129: a real 403 CDN block (status + cf-ray header) must be
    // detected via the actual `fetch()` call sites in probeFeasibility, not just when calling
    // detectBlockedResponse directly with hand-crafted inputs.
    it("detects a real 403 CDN block via the direct fetch call site", async () => {
        const blockedResponse = () =>
            new Response(
                `<!doctype html><html><head><title>Access Denied</title></head><body>Access Denied - you don't have permission to access this resource.</body></html>`,
                { status: 403, headers: { "cf-ray": "test-ray" } }
            );
        vi.spyOn(globalThis, "fetch").mockImplementation(async () => blockedResponse());
        vi.spyOn(console, "log").mockImplementation(() => undefined);
        vi.spyOn(console, "error").mockImplementation(() => undefined);

        const outcome = await probeFeasibility({ method: null }, "https://example.test");

        expect(outcome.code).toBe(28);
    });
});
