import chalk from "chalk";
import * as cheerio from "cheerio";
import makeRequest from "../../utility/makeReq.js";
import resolvePath from "../../utility/resolvePath.js";
import { getJsUrls, pushToJsUrls } from "../globals.js";
import { URL } from "url";
import { runWithConcurrency } from "../../utility/concurrency.js";

const ASSET_EXTENSIONS = [".js", ".css", ".json", ".png", ".svg", ".woff", ".woff2", ".ico", ".jpg", ".gif"];
const SKIP_PREFIXES = ["/_astro/", "/_next/", "/__"];

/**
 * Extracts path-like strings from a JS file's raw text content that look like
 * same-origin page routes (start with "/" and don't end with ".js"/".css"/etc).
 * Also detects template literal path prefixes like `/post/${...}` → `/post/1`
 * by substituting a test ID ("1") for the first dynamic segment.
 */
const extractPagePaths = (content: string): string[] => {
    const paths = new Set<string>();

    // Static string literals: "/admin", '/debug', etc.
    const STATIC_RE = /["'](\/[a-zA-Z0-9_\-/]+)["']/g;
    let m: RegExpExecArray | null;
    while ((m = STATIC_RE.exec(content)) !== null) {
        const p = m[1];
        if (ASSET_EXTENSIONS.some((e) => p.endsWith(e))) continue;
        if (SKIP_PREFIXES.some((pre) => p.startsWith(pre))) continue;
        if (p.split("/").length > 5) continue;
        paths.add(p);
    }

    // Template literal path prefixes: `/post/${...}` → try `/post/1`
    // Matches backtick template literals starting with "/" that have at least one ${} segment
    const TEMPLATE_RE = /`(\/[a-zA-Z0-9_\-/]+)\$\{[^`}]+\}(?:\/[a-zA-Z0-9_\-]*)*`/g;
    while ((m = TEMPLATE_RE.exec(content)) !== null) {
        const prefix = m[1]; // e.g. "/post/"
        if (SKIP_PREFIXES.some((pre) => prefix.startsWith(pre))) continue;
        // Strip trailing slash before appending test ID
        const base = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
        const testUrl = `${base}/1`;
        if (testUrl.split("/").length <= 5) paths.add(testUrl);
    }

    return [...paths];
};

/**
 * Extracts JS file references from an HTML page's Astro island elements,
 * <script src>, and <link rel="modulepreload"> tags.
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

const MAX_ROUNDS = 5;

/**
 * Iteratively scans all JS URLs in the global registry for embedded page path
 * strings, visits each discovered page to extract Astro island component-url /
 * script-src / modulepreload references, and repeats until no new URLs are found.
 *
 * This fills the gap left by Svelte/Astro client-side routers that don't emit
 * <a href> links in server-rendered HTML — instead route paths live as string
 * literals inside the compiled JS bundles.
 *
 * @param entryUrl - The target's base URL (used to build absolute page URLs)
 * @returns Array of all newly discovered JS file URLs across all rounds
 */
const svelte_discoverPagesFromJs = async (entryUrl: string, threads: number = 1): Promise<string[]> => {
    const origin = new URL(entryUrl).origin;
    const allDiscovered: string[] = [];
    const visitedPaths = new Set<string>();
    const scannedJsUrls = new Set<string>();

    for (let round = 0; round < MAX_ROUNDS; round++) {
        const currentJsUrls = getJsUrls().filter((u) => !scannedJsUrls.has(u));
        if (currentJsUrls.length === 0) break;

        // Collect candidate page paths from all unscanned JS URLs
        const candidatePaths = new Set<string>();
        await runWithConcurrency(currentJsUrls, threads, async (jsUrl) => {
            scannedJsUrls.add(jsUrl);
            try {
                const res = await makeRequest(jsUrl, {});
                if (!res) return;
                const content = await res.text();
                for (const p of extractPagePaths(content)) {
                    candidatePaths.add(p);
                }
            } catch {
                return;
            }
        });

        // Filter to only unvisited paths
        const newPaths = [...candidatePaths].filter((p) => !visitedPaths.has(p));
        if (newPaths.length === 0) break;

        console.log(
            chalk.cyan(`[i] Found ${newPaths.length} candidate page path(s) in JS — visiting to discover more chunks`)
        );

        let foundThisRound = 0;
        await runWithConcurrency(newPaths, threads, async (pagePath) => {
            visitedPaths.add(pagePath);
            const pageUrl = `${origin}${pagePath}`;
            try {
                const res = await makeRequest(pageUrl, {});
                if (!res) return;
                const contentType = res.headers.get("content-type") ?? "";
                if (!contentType.includes("text/html")) return;

                const html = await res.text();
                const jsFromPage = await extractJsFromHtml(pageUrl, html);

                for (const jsUrl of jsFromPage) {
                    if (!getJsUrls().includes(jsUrl)) {
                        pushToJsUrls(jsUrl);
                        allDiscovered.push(jsUrl);
                        foundThisRound++;
                    }
                }

                if (jsFromPage.length > 0) {
                    console.log(chalk.green(`[✓] ${pageUrl}: found ${jsFromPage.length} JS file(s)`));
                }
            } catch {
                // page not found or network error — skip
            }
        });

        if (foundThisRound === 0) break;
    }

    return allDiscovered;
};

export default svelte_discoverPagesFromJs;
