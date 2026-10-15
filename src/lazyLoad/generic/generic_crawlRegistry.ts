/**
 * Identifies the page a generic crawl effectively starts from: origin plus path, ignoring the
 * query string and fragment, which do not change which site is crawled.
 */
export const crawlStartKey = (finalUrl: string): string => {
    try {
        const parsed = new URL(finalUrl);
        return `${parsed.origin}${parsed.pathname}`;
    } catch {
        return finalUrl;
    }
};

/**
 * Remembers which start pages the generic crawler has already covered in this process, so a batch
 * whose targets all redirect to one page (wildcard-DNS subdomains, http/https pairs of one host,
 * vanity domains) crawls that site once instead of once per target. Re-running the same target
 * (e.g. a later pipeline pass) is never treated as a duplicate.
 */
export class GenericCrawlRegistry {
    private readonly crawledBy = new Map<string, string>();

    /**
     * Records that `target` crawls from `finalUrl`. Returns the earlier target that already crawled
     * from the same start page, or null when this target should crawl.
     */
    claim(finalUrl: string, target: string): string | null {
        const key = crawlStartKey(finalUrl);
        const earlierTarget = this.crawledBy.get(key);
        if (earlierTarget !== undefined && earlierTarget !== target) return earlierTarget;
        this.crawledBy.set(key, target);
        return null;
    }

    reset(): void {
        this.crawledBy.clear();
    }
}

/** Process-wide registry shared by every lazyload invocation in a batch run. */
export const genericCrawlRegistry = new GenericCrawlRegistry();
