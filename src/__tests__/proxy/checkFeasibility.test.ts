import { describe, it, expect } from "vitest";
import { determineFeasibilityOutcome } from "../../proxy/checkFeasibility.js";

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
