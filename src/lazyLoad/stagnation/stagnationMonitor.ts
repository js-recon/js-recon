import * as lazyLoadGlobals from "../globals.js";

/**
 * Detects content stagnation during a generic-tech crawl: once armed (past stagnationTimeinMs),
 * periodically checks whether one JS content hash dominates the discovered set. Rather than
 * stopping the instant the threshold is crossed, it arms a "pending" state and waits one more
 * stagnationMonitorMs interval — if a genuinely new content hash shows up in that window, it
 * resets (the crawl is still finding new content); only if the same dominant hash persists with
 * no new distinct content does it confirm stagnation and signal the caller to stop.
 */
export class StagnationMonitor {
    private readonly startTime: number;
    private lastCheckAt = 0;
    private pending = false;
    private pendingDistinctHashCount = 0;

    constructor(
        private readonly stagnationTimeinMs: number,
        private readonly stagnationPercentage: number,
        private readonly stagnationMonitorMs: number
    ) {
        this.startTime = Date.now();
    }

    /**
     * Whether enough time has passed (past the warm-up period, and since the last check) for
     * evaluate() to run again.
     */
    shouldEvaluate(): boolean {
        const now = Date.now();
        if (now - this.startTime < this.stagnationTimeinMs) return false;
        return now - this.lastCheckAt >= this.stagnationMonitorMs;
    }

    /**
     * Evaluates the current global JS content-hash distribution. Returns true only when
     * stagnation is confirmed (the caller should stop the crawl).
     */
    evaluate(): boolean {
        this.lastCheckAt = Date.now();

        const total = lazyLoadGlobals.getJsFileTotalCount();
        if (total === 0) return false;

        const counts = lazyLoadGlobals.getJsFileHashCounts();
        const dominantCount = Math.max(...counts.values());
        const dominantPercentage = (dominantCount / total) * 100;
        const distinctHashCount = counts.size;

        if (!this.pending) {
            if (dominantPercentage >= this.stagnationPercentage) {
                this.pending = true;
                this.pendingDistinctHashCount = distinctHashCount;
            }
            return false;
        }

        if (distinctHashCount > this.pendingDistinctHashCount) {
            // New distinct content appeared while pending — not stagnant, reset.
            this.pending = false;
            return false;
        }

        if (dominantPercentage >= this.stagnationPercentage) {
            return true;
        }

        this.pending = false;
        return false;
    }
}

export default StagnationMonitor;
