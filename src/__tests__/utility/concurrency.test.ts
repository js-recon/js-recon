import { describe, it, expect } from "vitest";
import { runWithConcurrency } from "../../utility/concurrency.js";
import { withRequestSignal } from "../../utility/requestSignal.js";

describe("runWithConcurrency", () => {
    it("processes every item exactly once", async () => {
        const items = [1, 2, 3, 4, 5, 6, 7, 8];
        const seen: number[] = [];

        await runWithConcurrency(items, 3, async (item) => {
            seen.push(item);
        });

        expect(seen.sort((a, b) => a - b)).toEqual(items);
    });

    it("does nothing for an empty items array", async () => {
        let called = false;
        await runWithConcurrency([], 4, async () => {
            called = true;
        });
        expect(called).toBe(false);
    });

    it("clamps threads <= 0 to at least one worker", async () => {
        const items = ["a", "b", "c"];
        const seen: string[] = [];

        await runWithConcurrency(items, 0, async (item) => {
            seen.push(item);
        });

        expect(seen.sort()).toEqual(["a", "b", "c"]);
    });

    it("clamps threads greater than items.length to items.length workers", async () => {
        const items = ["x", "y"];
        const seen: string[] = [];

        await runWithConcurrency(items, 50, async (item) => {
            seen.push(item);
        });

        expect(seen.sort()).toEqual(["x", "y"]);
    });

    it("continues processing other items when one worker call throws", async () => {
        const items = [1, 2, 3, 4];
        const seen: number[] = [];

        await runWithConcurrency(items, 2, async (item) => {
            if (item === 2) throw new Error("boom");
            seen.push(item);
        });

        expect(seen.sort((a, b) => a - b)).toEqual([1, 3, 4]);
    });
    it("stops claiming new items once the surrounding request scope is cancelled", async () => {
        const items = [1, 2, 3, 4, 5, 6, 7, 8];
        const seen: number[] = [];
        const controller = new AbortController();

        await withRequestSignal(controller.signal, () =>
            runWithConcurrency(items, 2, async (item) => {
                seen.push(item);
                if (item === 3) controller.abort();
            })
        );

        // Items 1-3 ran; at most one more was already claimed by the other worker.
        expect(seen.length).toBeGreaterThanOrEqual(3);
        expect(seen.length).toBeLessThanOrEqual(4);
    });

    it("runs nothing when the request scope is already cancelled", async () => {
        const controller = new AbortController();
        controller.abort();
        let called = false;

        await withRequestSignal(controller.signal, () =>
            runWithConcurrency([1, 2], 2, async () => {
                called = true;
            })
        );

        expect(called).toBe(false);
    });
});
