import { describe, expect, it } from "vitest";
import { BATCH_PARTIAL_FAILURE_EXIT_CODE, batchExitCode, batchFailureSummary } from "../../run/batchOutcome.js";

describe("batchExitCode", () => {
    it("exits 0 when every target succeeded", () => {
        expect(batchExitCode(0, 98)).toBe(0);
    });

    it("reserves its own exit code for a batch where only some targets failed", () => {
        expect(BATCH_PARTIAL_FAILURE_EXIT_CODE).toBe(36);
        expect(batchExitCode(4, 98)).toBe(BATCH_PARTIAL_FAILURE_EXIT_CODE);
        expect(batchExitCode(97, 98)).toBe(BATCH_PARTIAL_FAILURE_EXIT_CODE);
    });

    it("exits 1 when every target failed", () => {
        expect(batchExitCode(98, 98)).toBe(1);
        expect(batchExitCode(1, 1)).toBe(1);
    });
});

describe("batchFailureSummary", () => {
    it("names the failed and total target counts on one line", () => {
        const summary = batchFailureSummary(4, 98);
        expect(summary).toBe("[!] Batch completed: 4 of 98 targets failed");
        expect(summary).not.toContain("\n");
    });
});
