import generic_getScriptTags from "./generic_getScriptTags.js";
import generic_scanAttributesForJs from "./generic_scanAttributesForJs.js";
import generic_downloadFiles from "./generic_downloadFiles.js";
import generic_stringsDiscovery from "./generic_stringsDiscovery.js";
import generic_importMapDiscovery from "./generic_importMapDiscovery.js";
import generic_webpackChunkPaths from "./generic_webpackChunkPaths.js";
import { extractPageLinks } from "./generic_extractLinks.js";
import { resolveJsPathCandidate, confirmJsContentType } from "./generic_scanAttributesForJs.js";
import { accumulateTechnique } from "../researchUtils.js";
import * as lazyLoadGlobals from "../globals.js";
import { StagnationMonitor } from "../stagnation/stagnationMonitor.js";
import { printMsg, MSG } from "../../utility/printMsg.js";

// internal#74 / internal#75: import-map manifests and webpack chunk hash-maps are
// finite, already-known structures (unlike open-ended strings discovery) — a handful of
// rounds is enough to reach a fixed point in practice, but the loop stays bounded rather
// than unconditional in case a pathological manifest chain never converges.
const STRUCTURAL_DISCOVERY_MAX_ITERATIONS = 5;

/**
 * Whether a link's host is within the active scope list. "*" allows any host —
 * matches the sentinel convention already used by downloadFilesUtil.ts / downloadQueue.ts.
 */
export const isInScope = (url: string, scope: string[]): boolean => {
    if (scope.includes("*")) return true;
    try {
        return scope.includes(new URL(url).host);
    } catch {
        return false;
    }
};

/**
 * Recursively crawls in-scope HTML pages reachable via <a href> from seedUrl,
 * downloading JS discovered on each page (via generic_getScriptTags /
 * generic_scanAttributesForJs) and following newly discovered links until the
 * page pool is exhausted or maxPageVisits is reached. Implements internal#66:
 * following non-JS <a href> links recursively is what lets the generic tech
 * reach JS referenced only from pages the seed page doesn't link to directly.
 *
 * JS files are downloaded incrementally, page by page, rather than batched
 * until the whole crawl finishes — a multi-hundred-page crawl can take
 * minutes, and deferring every download to the end makes the tool look stuck.
 *
 * When stringsEnabled is set, once the page crawl is exhausted a second
 * discovery mode runs: generic_stringsDiscovery.ts scans every downloaded file
 * (inline scripts, decoded data: URIs, and external JS) for string-literal JS
 * paths using the existing `strings` module's AST-based extraction, resolves
 * each one against the URL the file it came from was downloaded from, and
 * downloads any new confirmed JS files. This repeats — new downloads feed the
 * next strings pass — until a pass finds nothing new or stringsMaxIterations
 * is reached, the same "loop until nothing new" shape as react_followImports.
 *
 * Regardless of stringsEnabled, once the page crawl is exhausted a structural
 * discovery pass runs unconditionally (internal#74, internal#75): generic_importMapDiscovery.ts
 * parses already-downloaded files for Module Federation "import map" manifests and seeds
 * every listed remote-entry.js URL, and generic_webpackChunkPaths.ts applies the same
 * webpack chunk-hash-map patterns the React crawler resolves (shared via
 * ../shared/webpackChunkParsers.ts) to statically enumerate a downloaded entry chunk's
 * own async-chunk set. Both repeat — newly downloaded files feed the next pass — until a
 * round finds nothing new, since a newly-discovered remote-entry.js can itself carry
 * either pattern.
 *
 * When stagnationTimeinMs > 0, a StagnationMonitor tracks JS content hashes (recorded
 * globally by generic_downloadFiles.ts / generic_getScriptTags.ts as files are discovered)
 * and, once armed, stops the crawl early if one content hash comes to dominate the
 * discovered set with no genuinely new content appearing — catches infinite/near-infinite
 * sites (blogs, news feeds) whose pages keep referencing cache-busted-but-identical JS.
 *
 * techDetectInterceptedUrls carries every request Puppeteer's tech-detection pass
 * already intercepted for this target (see techDetect/index.ts's getLastInterceptedUrls)
 * — this includes anything requested only because a runtime-injected script asked for
 * it (e.g. Cloudflare's own bot-challenge script self-injecting via
 * `element.innerHTML = "...;a.src='...';..."`), which a plain-fetch crawl has no way
 * to see on its own since the reference only exists once the page's JS actually runs.
 */
const generic_crawlPages = async (
    seedUrl: string,
    maxJsSizeMb: number,
    outputDir: string,
    maxPageVisits: number,
    threads: number,
    researchMap?: Record<string, string[]>,
    stringsEnabled: boolean = false,
    stringsMaxIterations: number = 5,
    techDetectInterceptedUrls: string[] = [],
    stagnationTimeinMs: number = 0,
    stagnationPercentage: number = 80,
    stagnationMonitorMs: number = 60000
): Promise<string[]> => {
    const visitedPages = new Set<string>();
    const queued = new Set<string>([seedUrl]);
    const queue: string[] = [seedUrl];
    const downloadedJsUrls = new Set<string>();
    const stagnationMonitor =
        stagnationTimeinMs > 0
            ? new StagnationMonitor(stagnationTimeinMs, stagnationPercentage, stagnationMonitorMs)
            : null;

    if (techDetectInterceptedUrls.length > 0) {
        const candidates = [
            ...new Set(
                techDetectInterceptedUrls
                    .map((u) => resolveJsPathCandidate(u, u))
                    .filter((u): u is string => u !== null)
            ),
        ];
        if (candidates.length > 0) {
            const confirmed = await confirmJsContentType(candidates);
            if (researchMap) accumulateTechnique(researchMap, "techDetect_interceptedUrls", confirmed);
            if (confirmed.length > 0) {
                confirmed.forEach((u) => downloadedJsUrls.add(u));
                await generic_downloadFiles(confirmed, outputDir, threads);
            }
        }
    }

    while (queue.length > 0) {
        if (maxPageVisits > 0 && visitedPages.size >= maxPageVisits) {
            printMsg(MSG.Warn, `[i] Reached max page visits (${maxPageVisits}); stopping generic crawl`);
            break;
        }

        if (stagnationMonitor?.shouldEvaluate() && stagnationMonitor.evaluate()) {
            printMsg(
                MSG.Warn,
                `[i] Detected content stagnation (dominant JS content ≥ ${stagnationPercentage}% with no new content); stopping generic crawl`
            );
            break;
        }

        const pageUrl = queue.shift() as string;
        if (visitedPages.has(pageUrl)) continue;
        visitedPages.add(pageUrl);

        printMsg(MSG.Header, `[i] Crawling page (${visitedPages.size}): ${pageUrl}`);

        const { urls: scriptUrls, pageSource } = await generic_getScriptTags(pageUrl, maxJsSizeMb, outputDir);
        if (researchMap) accumulateTechnique(researchMap, "generic_getScriptTags", scriptUrls);

        let newJsUrls = scriptUrls.filter((u) => !downloadedJsUrls.has(u));

        if (pageSource) {
            const attrCandidates = await generic_scanAttributesForJs(pageSource, pageUrl, downloadedJsUrls);
            if (researchMap) accumulateTechnique(researchMap, "generic_scanAttributesForJs", attrCandidates);
            newJsUrls = [...new Set([...newJsUrls, ...attrCandidates.filter((u) => !downloadedJsUrls.has(u))])];
        }

        if (newJsUrls.length > 0) {
            newJsUrls.forEach((u) => downloadedJsUrls.add(u));
            await generic_downloadFiles(newJsUrls, outputDir, threads);
        }

        if (!pageSource) continue;

        const scope = lazyLoadGlobals.getScope();
        const links = extractPageLinks(pageSource, pageUrl);
        const newLinks = links.filter((l) => isInScope(l, scope) && !queued.has(l));
        newLinks.forEach((l) => queued.add(l));
        if (researchMap) accumulateTechnique(researchMap, "generic_crawlPages", newLinks);
        queue.push(...newLinks);
    }

    for (let iteration = 0; iteration < STRUCTURAL_DISCOVERY_MAX_ITERATIONS; iteration++) {
        const [importMapUrls, chunkPathUrls] = await Promise.all([
            generic_importMapDiscovery(outputDir, downloadedJsUrls, threads),
            generic_webpackChunkPaths(outputDir, downloadedJsUrls, threads),
        ]);
        const freshUrls = [...new Set([...importMapUrls, ...chunkPathUrls])].filter((u) => !downloadedJsUrls.has(u));

        if (researchMap) accumulateTechnique(researchMap, "generic_importMapDiscovery", importMapUrls);
        if (researchMap) accumulateTechnique(researchMap, "generic_webpackChunkPaths", chunkPathUrls);

        if (freshUrls.length === 0) {
            if (iteration === 0) {
                printMsg(MSG.Warn, "[i] No import-map manifests or webpack chunk hash-maps found");
            }
            break;
        }

        printMsg(MSG.Run, `[✓] Found ${freshUrls.length} new JS file(s) via structural discovery`);
        freshUrls.forEach((u) => downloadedJsUrls.add(u));
        await generic_downloadFiles(freshUrls, outputDir, threads);
    }

    if (stringsEnabled) {
        for (let iteration = 0; stringsMaxIterations <= 0 || iteration < stringsMaxIterations; iteration++) {
            printMsg(MSG.Header, `[i] Running strings-based discovery pass ${iteration + 1}`);
            const candidates = await generic_stringsDiscovery(outputDir, downloadedJsUrls);
            const freshUrls = candidates.filter((u) => !downloadedJsUrls.has(u));

            if (researchMap) accumulateTechnique(researchMap, "generic_stringsDiscovery", freshUrls);

            if (freshUrls.length === 0) {
                printMsg(MSG.Warn, "[i] No new JS files found via strings; stopping strings discovery");
                break;
            }

            printMsg(MSG.Run, `[✓] Found ${freshUrls.length} new JS file(s) via strings`);
            freshUrls.forEach((u) => downloadedJsUrls.add(u));
            await generic_downloadFiles(freshUrls, outputDir, threads);
        }
    }

    return [...downloadedJsUrls];
};

export default generic_crawlPages;
