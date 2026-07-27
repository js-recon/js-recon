import chalk from "chalk";
import { URL } from "url";

import next_getJSScript from "./next_GetJSScript.js";
import next_GetLazyResourcesWebpackJs from "./next_GetLazyResourcesWebpackJs.js";
import next_getLazyResourcesBuildManifestJs from "./next_GetLazyResourcesBuildManifestJs.js";
import subsequentRequests from "./next_SubsequentRequests.js";
import next_promiseResolve from "./next_promiseResolve.js";
import next_parseLayoutJs from "./next_parseLayoutJs.js";
import next_scriptTagsSubsequentRequests from "./next_scriptTagsSubsequentRequests.js";
import next_bruteForceJsFiles from "./next_bruteForceJsFiles.js";
import next_getClientSidePaths from "./next_getClientSidePaths.js";

import * as lazyLoadGlobals from "../globals.js";
import { shouldRunMethod } from "../methodFilter.js";

interface NextJsCrawlerOptions {
    url: string;
    output: string;
    subsequentRequestsFlag: boolean;
    urlsFile: string;
    threads: number;
    research: boolean;
    maxIterations: number;
    /** Maximum number of HTML pages to visit across all recursive passes. 0 = unlimited. */
    maxPageVisits?: number;
    /** Called with newly discovered downloadable URLs as they are found. */
    onUrlsDiscovered?: (urls: string[]) => void;
    /** Whitelist of method names to run (empty = run all). */
    includeMethods?: string[];
    /** Blacklist of method names to skip (empty = skip none). */
    excludeMethods?: string[];
}

/**
 * Encapsulates the Next.js JS file discovery logic with recursive crawling.
 *
 * After running all discovery methods once, the crawler re-runs path-sensitive
 * methods (promiseResolve, parseLayoutJs, getJSScript) on any *newly* found
 * URLs until no new JS files are discovered, ensuring full coverage.
 */
class NextJsCrawler {
    private readonly url: string;
    private readonly output: string;
    private readonly subsequentRequestsFlag: boolean;
    private readonly urlsFile: string;
    private readonly threads: number;
    private readonly research: boolean;

    /** All JS/JSON URLs discovered so far (deduplicated). */
    private discoveredUrls: Set<string>;

    /**
     * Script-fingerprint map used for content-entropy deduplication.
     * Key: normalized page URL (origin+pathname).
     * Value: set of fingerprints (sorted, joined script-src lists) seen for that path.
     * A query-param variant of an already-visited path is only crawled when its
     * script set differs from every fingerprint already recorded for that path.
     */
    private pageScriptFingerprints: Map<string, Set<string>>;

    /** Per-technique efficiency mapping (for research mode). */
    public techniqueEfficiencyMapping: Record<string, string[]>;

    /** Maximum number of recursive passes before giving up. */
    private MAX_ITERATIONS: number;

    /** Maximum HTML pages to visit across all recursive passes (0 = unlimited). */
    private readonly MAX_PAGE_VISITS: number;

    /** Total HTML pages visited across all recursive passes. */
    private totalPagesVisited = 0;

    /** Set to true by stop() to abort the crawl loop gracefully. */
    private stopped = false;

    /** Callback invoked with newly discovered downloadable URLs. */
    private readonly onUrlsDiscovered?: (urls: string[]) => void;

    private readonly includeMethods: string[];
    private readonly excludeMethods: string[];

    constructor(options: NextJsCrawlerOptions) {
        if (
            options.maxPageVisits !== undefined &&
            (!Number.isInteger(options.maxPageVisits) || options.maxPageVisits < 0)
        ) {
            throw new Error("maxPageVisits must be a non-negative integer (0 = unlimited)");
        }

        this.url = options.url;
        this.output = options.output;
        this.subsequentRequestsFlag = options.subsequentRequestsFlag;
        this.urlsFile = options.urlsFile;
        this.threads = options.threads;
        this.research = options.research;
        this.MAX_ITERATIONS = options.maxIterations;
        this.MAX_PAGE_VISITS = options.maxPageVisits ?? 200;
        this.onUrlsDiscovered = options.onUrlsDiscovered;
        this.includeMethods = options.includeMethods ?? [];
        this.excludeMethods = options.excludeMethods ?? [];

        this.discoveredUrls = new Set();
        this.pageScriptFingerprints = new Map();
        this.techniqueEfficiencyMapping = {};
    }

    // ── helpers ──────────────────────────────────────────────────────────

    /**
     * Normalizes a page URL to origin+pathname, stripping query and fragment.
     * Used as the key for pageScriptFingerprints.
     */
    private normalizePageUrl(u: string): string {
        try {
            const parsed = new URL(u);
            return parsed.origin + parsed.pathname;
        } catch {
            return u;
        }
    }

    /** Produces a stable fingerprint for a set of script URLs. */
    private scriptFingerprint(scripts: string[]): string {
        return [...new Set(scripts)].sort().join(",");
    }

    /** Signal the crawl loop to stop after the current iteration. */
    public stop(): void {
        this.stopped = true;
    }

    /** Register newly found URLs and return only the ones that are truly new. */
    private registerUrls(urls: string[]): string[] {
        const newUrls: string[] = [];
        for (const u of urls) {
            if (!this.discoveredUrls.has(u)) {
                this.discoveredUrls.add(u);
                newUrls.push(u);
            }
        }
        return newUrls;
    }

    /** Emit newly discovered downloadable assets to the onUrlsDiscovered callback. */
    private emitDownloadable(urls: string[]): void {
        if (!this.onUrlsDiscovered) return;
        const downloadable = urls.filter((u) => {
            try {
                const p = new URL(u).pathname;
                return p.endsWith(".js") || p.endsWith(".js.map");
            } catch {
                return false;
            }
        });
        if (downloadable.length > 0) this.onUrlsDiscovered(downloadable);
    }

    /** Snapshot the current size so we can detect growth. */
    private get size(): number {
        return this.discoveredUrls.size;
    }

    // ── initial discovery (run-once methods) ─────────────────────────────

    /**
     * Runs the heavyweight / one-shot discovery methods that only need to
     * execute once (puppeteer-based webpack analysis, build-manifest, etc.).
     */
    private async initialDiscovery(): Promise<void> {
        const inc = this.includeMethods;
        const exc = this.excludeMethods;

        // 1. Script tags on the landing page
        const jsFromScriptTag = shouldRunMethod("next_GetJSScript", inc, exc) ? await next_getJSScript(this.url) : [];
        this.techniqueEfficiencyMapping["next_getJSScript"] = [
            ...(this.techniqueEfficiencyMapping["next_getJSScript"] || []),
            ...jsFromScriptTag,
        ];
        this.emitDownloadable(this.registerUrls(jsFromScriptTag));
        // Record the landing page's script fingerprint so the recursive loop
        // never re-probes it.
        const landingNorm = this.normalizePageUrl(this.url);
        this.pageScriptFingerprints.set(landingNorm, new Set([this.scriptFingerprint(jsFromScriptTag)]));

        // 1b. Client-side paths from <a href> tags on the landing page.
        // These are page URLs (not JS), so they'll be picked up by the
        // recursivePass loop which visits any newly registered non-JS URL.
        if (shouldRunMethod("next_getClientSidePaths", inc, exc)) {
            const pathsFromAnchors = await next_getClientSidePaths(this.url);
            this.techniqueEfficiencyMapping["next_getClientSidePaths"] = [
                ...(this.techniqueEfficiencyMapping["next_getClientSidePaths"] || []),
                ...pathsFromAnchors,
            ];
            this.emitDownloadable(this.registerUrls(pathsFromAnchors));
        }

        // 2. Webpack runtime analysis (puppeteer – expensive, run once per target).
        // Skip in subsequent-requests passes: the webpack chunk URL builders are static
        // and were already resolved in the initial lazyload call; re-running this costs
        // 3-6 minutes per call without discovering new URLs.
        if (!this.subsequentRequestsFlag && shouldRunMethod("next_GetLazyResourcesWebpackJs", inc, exc)) {
            const jsFromWebpack = await next_GetLazyResourcesWebpackJs(this.url, this.threads);
            this.techniqueEfficiencyMapping["next_GetLazyResourcesWebpackJs"] = jsFromWebpack;
            lazyLoadGlobals.pushToJsUrls(jsFromWebpack);
            this.emitDownloadable(this.registerUrls(jsFromWebpack));
        }

        // 3. _buildManifest.js
        if (shouldRunMethod("next_GetLazyResourcesBuildManifestJs", inc, exc)) {
            const jsFromBuildManifest = await next_getLazyResourcesBuildManifestJs(this.url);
            this.techniqueEfficiencyMapping["next_getLazyResourcesBuildManifestJs"] = jsFromBuildManifest;
            lazyLoadGlobals.pushToJsUrls(jsFromBuildManifest);
            this.emitDownloadable(this.registerUrls(jsFromBuildManifest));
        }

        // 4. Subsequent requests (RSC / script-tags on known endpoints)
        if (this.subsequentRequestsFlag) {
            if (shouldRunMethod("next_SubsequentRequests", inc, exc)) {
                const jsFromSubsequent = await subsequentRequests(
                    this.url,
                    this.urlsFile,
                    this.threads,
                    this.output,
                    lazyLoadGlobals.getJsUrls()
                );
                this.techniqueEfficiencyMapping["subsequentRequests"] = [...jsFromSubsequent];
                this.emitDownloadable(this.registerUrls([...jsFromSubsequent]));
            }

            if (shouldRunMethod("next_scriptTagsSubsequentRequests", inc, exc)) {
                const jsFromScriptTagsSR = await next_scriptTagsSubsequentRequests(
                    this.url,
                    this.urlsFile,
                    this.threads
                );
                this.techniqueEfficiencyMapping["next_scriptTagsSubsequentRequests"] = jsFromScriptTagsSR;
                lazyLoadGlobals.pushToJsUrls(jsFromScriptTagsSR);
                this.emitDownloadable(this.registerUrls(jsFromScriptTagsSR));
            }
        }

        // Also pull in anything the globals accumulated
        this.emitDownloadable(this.registerUrls(lazyLoadGlobals.getJsUrls()));
        this.emitDownloadable(this.registerUrls(lazyLoadGlobals.getJsonUrls()));
    }

    // ── recursive discovery ──────────────────────────────────────────────

    /**
     * Runs the lightweight methods that can discover *more* URLs from an
     * existing set of JS file URLs. These are cheap enough to repeat.
     *
     * @param jsUrls The JS URLs to analyse in this pass.
     * @returns Newly discovered URLs in this pass.
     */
    private async recursivePass(jsUrls: string[]): Promise<string[]> {
        const inc = this.includeMethods;
        const exc = this.excludeMethods;
        let newInThisPass: string[] = [];

        // Promise.all pattern analysis on JS file contents
        if (shouldRunMethod("next_promiseResolve", inc, exc)) {
            const jsFromPromise = await next_promiseResolve(jsUrls, this.threads);
            this.techniqueEfficiencyMapping["next_promiseResolve"] = [
                ...(this.techniqueEfficiencyMapping["next_promiseResolve"] || []),
                ...jsFromPromise,
            ];
            const newFromPromise = this.registerUrls(jsFromPromise);
            this.emitDownloadable(newFromPromise);
            newInThisPass.push(...newFromPromise);
        }

        // Layout.js parsing → discovers new client-side page paths → visits them
        if (shouldRunMethod("next_parseLayoutJs", inc, exc)) {
            const jsFromLayout = await next_parseLayoutJs(this.url, jsUrls, this.threads);
            this.techniqueEfficiencyMapping["next_parseLayoutJs"] = [
                ...(this.techniqueEfficiencyMapping["next_parseLayoutJs"] || []),
                ...jsFromLayout,
            ];
            const newFromLayout = this.registerUrls(jsFromLayout);
            this.emitDownloadable(newFromLayout);
            newInThisPass.push(...newFromLayout);
        }

        // Build a queue of unvisited page URLs to walk. Seed it with:
        //   - unvisited page URLs from the input batch (anchor-derived URLs
        //     registered by initialDiscovery, or pages from earlier passes
        //     that haven't been visited yet)
        //   - new page URLs discovered above (parseLayoutJs etc.)
        // For every page URL visited we run script-tag extraction AND
        // <a href> extraction, then enqueue any new page URLs that surfaces.
        // visitedPageUrls breaks cycles.
        const isPageUrl = (u: string): boolean => {
            let parsed: URL;
            try {
                parsed = new URL(u);
            } catch {
                return false;
            }
            return !parsed.pathname.endsWith(".js") && !parsed.pathname.endsWith(".js.map");
        };

        const pageQueue: string[] = [];
        const enqueued = new Set<string>(); // tracks full URLs to avoid duplicate entries per pass
        const enqueueIfPage = (u: string) => {
            if (this.MAX_PAGE_VISITS > 0 && this.totalPagesVisited + pageQueue.length >= this.MAX_PAGE_VISITS) return;
            if (enqueued.has(u)) return; // exact URL already queued this pass
            if (!isPageUrl(u)) return;
            enqueued.add(u);
            pageQueue.push(u);
        };

        for (const u of jsUrls) enqueueIfPage(u);
        for (const u of newInThisPass) enqueueIfPage(u);

        for (const u of pageQueue) {
            if (this.stopped) break; // honour stop() at each iteration boundary

            if (this.MAX_PAGE_VISITS > 0 && this.totalPagesVisited >= this.MAX_PAGE_VISITS) {
                console.error(
                    chalk.yellow(
                        `[!] Page visit cap reached (${this.MAX_PAGE_VISITS}). Skipping remaining pages in queue.`
                    )
                );
                break;
            }

            this.totalPagesVisited++;
            const normalized = this.normalizePageUrl(u);

            // Fetch scripts first — used for both fingerprinting and URL registration.
            const extra = shouldRunMethod("next_GetJSScript", inc, exc) ? await next_getJSScript(u) : [];

            if (!extra || !Array.isArray(extra)) {
                console.error(`[NextJsCrawler] Invalid return value from next_getJSScript for URL: ${u}`);
                console.error(`[NextJsCrawler] Returned value:`, extra);
                process.exit(1);
            }

            // Content-entropy dedup: skip this variant if its script set matches
            // a fingerprint already recorded for this pathname.
            const fp = this.scriptFingerprint(extra);
            const knownFPs = this.pageScriptFingerprints.get(normalized);
            if (knownFPs?.has(fp)) continue;

            // New content for this pathname — record fingerprint and process.
            if (!this.pageScriptFingerprints.has(normalized)) {
                this.pageScriptFingerprints.set(normalized, new Set());
            }
            this.pageScriptFingerprints.get(normalized)!.add(fp);

            this.techniqueEfficiencyMapping["next_getJSScript"] = [
                ...(this.techniqueEfficiencyMapping["next_getJSScript"] || []),
                ...extra,
            ];

            const newFromScripts = this.registerUrls(extra);
            this.emitDownloadable(newFromScripts);
            newInThisPass.push(...newFromScripts);
            for (const x of newFromScripts) enqueueIfPage(x);

            // Harvest <a href> links from this page so we keep expanding
            // the crawl frontier.
            if (shouldRunMethod("next_getClientSidePaths", inc, exc)) {
                const morePaths = await next_getClientSidePaths(u);
                this.techniqueEfficiencyMapping["next_getClientSidePaths"] = [
                    ...(this.techniqueEfficiencyMapping["next_getClientSidePaths"] || []),
                    ...morePaths,
                ];
                const newFromAnchors = this.registerUrls(morePaths);
                this.emitDownloadable(newFromAnchors);
                newInThisPass.push(...newFromAnchors);
                for (const x of newFromAnchors) enqueueIfPage(x);
            }
        }

        return newInThisPass;
    }

    // ── public API ───────────────────────────────────────────────────────

    /**
     * Main entry-point.  Runs initial discovery, then iterates recursive
     * passes until convergence (no new URLs) or the iteration cap.
     *
     * @returns The complete, deduplicated list of JS/asset URLs to download.
     */
    async crawl(): Promise<string[]> {
        // Phase 1 – initial heavyweight discovery
        await this.initialDiscovery();

        // Phase 2 – recursive lightweight passes
        let currentBatch = [...this.discoveredUrls];
        let iteration = 0;

        while (iteration < this.MAX_ITERATIONS && !this.stopped) {
            iteration++;
            const sizeBefore = this.size;

            console.log(chalk.cyan(`[i] Recursive crawl pass ${iteration} – ${sizeBefore} URLs known`));

            const newUrls = await this.recursivePass(currentBatch);

            if (newUrls.length === 0) {
                console.log(chalk.green(`[✓] Recursive crawl converged after ${iteration} pass(es)`));
                break;
            }

            console.log(chalk.green(`[+] Pass ${iteration} discovered ${newUrls.length} new URL(s)`));

            // Next pass only analyses the newly found URLs
            currentBatch = newUrls;
        }

        if (this.stopped) {
            console.error(chalk.yellow(`[!] Crawler stopped — downloading all discovered files`));
        } else if (iteration >= this.MAX_ITERATIONS) {
            console.error(chalk.yellow(`[!] Reached max recursive crawl iterations (${this.MAX_ITERATIONS})`));
        }

        // Phase 3 – brute-force .map files on the final set (skip if stopped by timeout)
        if (!this.stopped && shouldRunMethod("next_bruteForceJsFiles", this.includeMethods, this.excludeMethods)) {
            const allJsUrls = [...this.discoveredUrls].filter((u) => u.endsWith(".js") || u.endsWith(".js.map"));
            const jsFromBrute = await next_bruteForceJsFiles(allJsUrls, this.threads);
            this.techniqueEfficiencyMapping["next_bruteForceJsFiles"] = jsFromBrute;
            this.emitDownloadable(this.registerUrls(jsFromBrute));
        }

        // Only return downloadable assets. Anchor-derived page URLs live in
        // discoveredUrls to drive the crawl, but must not reach downloadFiles.
        return [...this.discoveredUrls].filter((u) => {
            try {
                const p = new URL(u).pathname;
                return p.endsWith(".js") || p.endsWith(".js.map");
            } catch {
                return false;
            }
        });
    }
}

export default NextJsCrawler;
