import { describe, expect, it } from "vitest";
import { BrowserFallbackGuard } from "../../utility/browserFallbackGuard.js";

describe("BrowserFallbackGuard", () => {
    it("allows attempts for a host it has never seen", () => {
        expect(new BrowserFallbackGuard(3).shouldAttempt("example.com")).toBe(true);
    });

    it("suppresses a host after the configured number of consecutive failures", () => {
        const guard = new BrowserFallbackGuard(3);

        expect(guard.recordFailure("example.com")).toBe(false);
        expect(guard.recordFailure("example.com")).toBe(false);
        expect(guard.shouldAttempt("example.com")).toBe(true);
        expect(guard.recordFailure("example.com")).toBe(true);
        expect(guard.shouldAttempt("example.com")).toBe(false);
    });

    it("reports the suppressing failure only once", () => {
        const guard = new BrowserFallbackGuard(1);

        expect(guard.recordFailure("example.com")).toBe(true);
        expect(guard.recordFailure("example.com")).toBe(false);
    });

    it("resets the failure streak on success", () => {
        const guard = new BrowserFallbackGuard(2);

        guard.recordFailure("example.com");
        guard.recordSuccess("example.com");
        expect(guard.recordFailure("example.com")).toBe(false);
        expect(guard.shouldAttempt("example.com")).toBe(true);
    });

    it("tracks hosts independently", () => {
        const guard = new BrowserFallbackGuard(1);

        guard.recordFailure("blocked.example.com");
        expect(guard.shouldAttempt("blocked.example.com")).toBe(false);
        expect(guard.shouldAttempt("www.example.com")).toBe(true);
    });

    it("forgets every host on reset", () => {
        const guard = new BrowserFallbackGuard(1);

        guard.recordFailure("example.com");
        guard.reset();
        expect(guard.shouldAttempt("example.com")).toBe(true);
    });
});
