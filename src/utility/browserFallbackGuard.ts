/**
 * Per-host circuit breaker for the headless-browser CDN/WAF fallback in `makeReq.ts`.
 *
 * A host whose challenge the browser cannot clear stays that way for the rest of a run, yet
 * without a breaker every request to it pays for another browser attempt (a page load plus a
 * fixed settle wait). On a 200-page crawl of such a site that is hundreds of futile attempts per
 * target. After `maxConsecutiveFailures` failures in a row with no success in between, further
 * attempts for that host are skipped and the caller keeps the response it already has.
 */
export const BROWSER_FALLBACK_MAX_CONSECUTIVE_FAILURES = 3;

export class BrowserFallbackGuard {
    private readonly consecutiveFailures = new Map<string, number>();
    private readonly suppressedHosts = new Set<string>();

    constructor(private readonly maxConsecutiveFailures: number = BROWSER_FALLBACK_MAX_CONSECUTIVE_FAILURES) {}

    /** Whether a browser attempt for `host` is still worth making. */
    shouldAttempt(host: string): boolean {
        return !this.suppressedHosts.has(host);
    }

    recordSuccess(host: string): void {
        this.consecutiveFailures.delete(host);
    }

    /** Records a failed attempt; returns true only for the failure that suppresses `host`. */
    recordFailure(host: string): boolean {
        if (this.suppressedHosts.has(host)) return false;
        const failures = (this.consecutiveFailures.get(host) ?? 0) + 1;
        this.consecutiveFailures.set(host, failures);
        if (failures < this.maxConsecutiveFailures) return false;
        this.suppressedHosts.add(host);
        return true;
    }

    reset(): void {
        this.consecutiveFailures.clear();
        this.suppressedHosts.clear();
    }
}

/** Process-wide breaker shared by every `makeRequest` call. */
export const browserFallbackGuard = new BrowserFallbackGuard();
