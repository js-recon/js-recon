import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../lazyLoad/globals.js", () => ({
    getJsFileTotalCount: vi.fn(),
    getJsFileHashCounts: vi.fn(),
}));

import { getJsFileTotalCount, getJsFileHashCounts } from "../../lazyLoad/globals.js";
import { StagnationMonitor } from "../../lazyLoad/stagnation/stagnationMonitor.js";

const setCounts = (counts: Record<string, number>) => {
    const map = new Map(Object.entries(counts));
    const total = [...map.values()].reduce((a, b) => a + b, 0);
    (getJsFileTotalCount as ReturnType<typeof vi.fn>).mockReturnValue(total);
    (getJsFileHashCounts as ReturnType<typeof vi.fn>).mockReturnValue(map);
};

describe("StagnationMonitor", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("shouldEvaluate is false before the warm-up period elapses", () => {
        const monitor = new StagnationMonitor(30_000, 80, 10_000);
        vi.setSystemTime(29_999);
        expect(monitor.shouldEvaluate()).toBe(false);
    });

    it("shouldEvaluate is true once the warm-up period elapses", () => {
        const monitor = new StagnationMonitor(30_000, 80, 10_000);
        vi.setSystemTime(30_000);
        expect(monitor.shouldEvaluate()).toBe(true);
    });

    it("evaluate does not confirm stagnation on the first call that crosses the threshold", () => {
        setCounts({ a: 9, b: 1 });
        const monitor = new StagnationMonitor(0, 80, 10_000);
        expect(monitor.evaluate()).toBe(false);
    });

    it("shouldEvaluate respects the monitor interval after arming", () => {
        const monitor = new StagnationMonitor(0, 80, 10_000);
        setCounts({ a: 9, b: 1 });
        monitor.evaluate();
        vi.setSystemTime(9_999);
        expect(monitor.shouldEvaluate()).toBe(false);
        vi.setSystemTime(10_000);
        expect(monitor.shouldEvaluate()).toBe(true);
    });

    it("confirms stagnation when the dominant hash persists with no new distinct content", () => {
        const monitor = new StagnationMonitor(0, 80, 10_000);
        setCounts({ a: 9, b: 1 });
        expect(monitor.evaluate()).toBe(false); // arms
        setCounts({ a: 15, b: 1 }); // same 2 distinct hashes, dominant grew
        expect(monitor.evaluate()).toBe(true); // confirmed
    });

    it("resets and does not confirm when a new distinct hash appears while pending", () => {
        const monitor = new StagnationMonitor(0, 80, 10_000);
        setCounts({ a: 9, b: 1 });
        expect(monitor.evaluate()).toBe(false); // arms
        setCounts({ a: 9, b: 1, c: 1 }); // new distinct hash appeared
        expect(monitor.evaluate()).toBe(false); // not stagnant, resets
    });

    it("does not arm when dominant percentage is below the threshold", () => {
        const monitor = new StagnationMonitor(0, 80, 10_000);
        setCounts({ a: 5, b: 4, c: 1 }); // dominant = 50%
        expect(monitor.evaluate()).toBe(false);
        setCounts({ a: 5, b: 4, c: 1 });
        expect(monitor.evaluate()).toBe(false);
    });

    it("returns false when no files have been recorded yet", () => {
        setCounts({});
        const monitor = new StagnationMonitor(0, 80, 10_000);
        expect(monitor.evaluate()).toBe(false);
    });

    it("un-arms if the dominant percentage drops below threshold on the pending check", () => {
        const monitor = new StagnationMonitor(0, 80, 10_000);
        setCounts({ a: 9, b: 1 });
        expect(monitor.evaluate()).toBe(false); // arms
        setCounts({ a: 9, b: 10 }); // distinct count unchanged (2), dominant now ~52.6% < 80%
        expect(monitor.evaluate()).toBe(false);
    });
});
