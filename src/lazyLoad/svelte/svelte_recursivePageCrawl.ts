import * as cheerio from "cheerio";
import makeRequest from "../../utility/makeReq.js";
import resolvePath from "../../utility/resolvePath.js";
import { URL } from "url";
import { pushToJsUrls } from "../globals.js";
import react_followImports from "../react/react_followImports.js";
import { printMsg, MSG } from "../../utility/printMsg.js";

const STAGNATION_LIMIT = 3;

/**
 * Extracts same-origin page URLs from <a href> and <link href> tags.
 * Hash fragments are stripped; only URLs matching the entry origin are returned.
 */
const extractPageLinks = (pageUrl: string, html: string): string[] => {
    const $ = cheerio.load(html);
    const origin = new URL(pageUrl).origin;
    const links = new Set<string>();

    $("a[href], link[href]").each((_, el) => {
        const href = $(el).attr("href");
        if (!href) return;
        try {
            const resolved = new URL(href, pageUrl);
            if (resolved.origin !== origin) return;
            resolved.hash = "";
            links.add(resolved.href);
        } catch {
            // unparseable href — skip
        }
    });

    return [...links];
};

/**
 * Extracts JS file URLs from pre-fetched HTML: <link rel="modulepreload">,
 * <script src>, and Astro island component-url attributes.
 */
const extractJsFromHtml = async (pageUrl: string, html: string): Promise<string[]> => {
    const $ = cheerio.load(html);
    const jsFiles: string[] = [];

    for (const el of $("link").toArray()) {
        const rel = $(el).attr("rel");
        if (rel === "modulepreload") {
            const href = $(el).attr("href");
            if (href) jsFiles.push(href.startsWith("http") ? href : await resolvePath(pageUrl, href));
        }
    }

    for (const el of $("script").toArray()) {
        const src = $(el).attr("src");
        if (src) jsFiles.push(src.startsWith("http") ? src : await resolvePath(pageUrl, src));
    }

    for (const el of $("astro-island").toArray()) {
        for (const attr of ["component-url", "renderer-url"]) {
            const value = $(el).attr(attr);
            if (value) jsFiles.push(value.startsWith("http") ? value : await resolvePath(pageUrl, value));
        }
    }

    return jsFiles;
};

/**
 * Recursively crawls same-origin HTML pages discovered via <a href> and
 * <link href> links.  For every page that responds with text/html, it runs
 * the full JS-discovery pipeline (HTML extraction + ESM import following)
 * and queues any new page links for further recursion.
 *
 * Termination:
 *   - pending queue is exhausted, or
 *   - STAGNATION_LIMIT consecutive rounds produce no new JS files.
 *
 * Already-visited pages are never re-processed; ESM import traversal
 * reuses a single visited Set across all pages so no JS file is fetched
 * twice.
 */
const svelte_recursivePageCrawl = async (
    entryUrl: string,
    maxJsSizeMb: number = 2,
    onFilesDiscovered?: (files: string[]) => void
): Promise<string[]> => {
    const allJsFiles = new Set<string>();
    const visitedPages = new Set<string>([entryUrl]);
    const knownPages = new Set<string>([entryUrl]);
    const importVisited = new Set<string>();

    // Seed from entry page
    const entryRes = await makeRequest(entryUrl, {});
    if (!entryRes) return [];
    const entryHtml = await entryRes.text();
    const initialLinks = extractPageLinks(entryUrl, entryHtml);

    const pendingPages: string[] = [];
    for (const link of initialLinks) {
        if (!knownPages.has(link)) {
            knownPages.add(link);
            pendingPages.push(link);
        }
    }

    if (pendingPages.length === 0) return [];

    printMsg(MSG.Header, `[i] Found ${pendingPages.length} candidate page link(s) for recursive JS discovery`);

    let stagnantRounds = 0;

    while (pendingPages.length > 0) {
        const batch = pendingPages.splice(0);
        const sizeBeforeRound = allJsFiles.size;

        for (const pageUrl of batch) {
            if (visitedPages.has(pageUrl)) continue;
            visitedPages.add(pageUrl);

            try {
                const res = await makeRequest(pageUrl, {});
                if (!res) continue;

                const contentType = res.headers.get("content-type") ?? "";
                if (!contentType.includes("text/html")) continue;

                const html = await res.text();

                // Extract JS files from this page's HTML
                const jsFromPage = await extractJsFromHtml(pageUrl, html);
                if (jsFromPage.length > 0) {
                    for (const f of jsFromPage) {
                        pushToJsUrls(f);
                        allJsFiles.add(f);
                    }
                    if (onFilesDiscovered) onFilesDiscovered(jsFromPage);
                    printMsg(MSG.Run, `[✓] ${pageUrl}: extracted ${jsFromPage.length} JS file(s)`);
                }

                // Follow ESM imports from the newly found JS files
                let toFollow = jsFromPage.filter((f) => !importVisited.has(f));
                while (toFollow.length > 0) {
                    const newFiles = await react_followImports(toFollow, maxJsSizeMb, pageUrl, importVisited);
                    if (newFiles.length === 0) break;
                    for (const f of newFiles) {
                        pushToJsUrls(f);
                        allJsFiles.add(f);
                    }
                    if (onFilesDiscovered) onFilesDiscovered(newFiles);
                    toFollow = newFiles;
                }

                // Queue newly discovered same-origin page links
                const newLinks = extractPageLinks(pageUrl, html);
                for (const link of newLinks) {
                    if (!knownPages.has(link)) {
                        knownPages.add(link);
                        pendingPages.push(link);
                    }
                }
            } catch (err) {
                printMsg(
                    MSG.Warn,
                    `[!] Failed to crawl ${pageUrl}: ${err instanceof Error ? err.message : String(err)}`
                );
            }
        }

        const newFilesThisRound = allJsFiles.size - sizeBeforeRound;
        if (newFilesThisRound === 0) {
            stagnantRounds++;
            if (stagnantRounds >= STAGNATION_LIMIT) {
                printMsg(
                    MSG.Warn,
                    `[!] Stopping page crawl: ${STAGNATION_LIMIT} consecutive rounds without new JS files`
                );
                break;
            }
        } else {
            stagnantRounds = 0;
        }
    }

    if (allJsFiles.size > 0) {
        printMsg(
            MSG.Run,
            `[✓] Recursive page crawl found ${allJsFiles.size} JS file(s) across ${visitedPages.size - 1} page(s)`
        );
    }

    return [...allJsFiles];
};

export default svelte_recursivePageCrawl;
