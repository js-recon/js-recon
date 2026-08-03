import { describe, expect, it } from "vitest";
import { awaitCancellableStep } from "../../run/cancellableStep.js";

describe("awaitCancellableStep", () => {
    it("aborts on skip but does not return while the step still owns background work", async () => {
        let resolveSkip!: () => void;
        let resolveWork!: () => void;
        let signal!: AbortSignal;
        let settled = false;
        const skip = new Promise<void>((resolve) => {
            resolveSkip = resolve;
        });

        const result = awaitCancellableStep((stepSignal) => {
            signal = stepSignal;
            return new Promise<void>((resolve) => {
                resolveWork = resolve;
            });
        }, skip).then(() => {
            settled = true;
        });

        resolveSkip();
        await new Promise((resolve) => setImmediate(resolve));
        expect(signal.aborted).toBe(true);
        expect(settled).toBe(false);

        resolveWork();
        await result;
        expect(settled).toBe(true);
    });
});
