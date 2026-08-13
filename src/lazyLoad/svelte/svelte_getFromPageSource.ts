import makeRequest from "../../utility/makeReq.js";
import * as cheerio from "cheerio";
import resolvePath from "../../utility/resolvePath.js";
import { getJsUrls, pushToJsUrls } from "../globals.js";
import { printMsg, MSG } from "../../utility/printMsg.js";

/**
 * Scans an inline `<script>` tag body for `.js` paths referenced by either a dynamic
 * `import("...")` call (SvelteKit `adapter-node`'s `Promise.all([import("./_app/immutable/entry/start.js"), ...])`
 * boot pattern), a static ES `import ... from "...js"` declaration (SvelteKit's
 * `import { start } from "./_app/immutable/start-<hash>.js"` boot pattern inside a
 * `<script type="module">` block), or — only when neither import form matches anything —
 * a plain quoted string literal ending in `.js` (Sapper's legacy boot pattern, where the
 * entry-chunk path is assigned to a variable and later used to set `.src` on a
 * `document.createElement("script")` element at runtime, with no `import(...)` call and no
 * `<script src>` anywhere in the markup). Returns deduped paths in first-seen order.
 *
 * @param {string} body - The inline script tag's text content.
 * @returns {string[]} - Deduped `.js` paths found in the body.
 */
export const extractInlineScriptJsPaths = (body: string): string[] => {
    const paths: string[] = [];
    const seen = new Set<string>();

    const patterns = [
        /\bimport\(\s*["']([^"']+\.js)["']\s*\)/g,
        /\bimport\s+(?:[\w${},\s*]+\s+from\s+)?["']([^"']+\.js)["']/g,
    ];

    for (const pattern of patterns) {
        for (const m of body.matchAll(pattern)) {
            const importPath = m[1];
            if (!seen.has(importPath)) {
                seen.add(importPath);
                paths.push(importPath);
            }
        }
    }

    if (paths.length === 0) {
        const literalPattern = /["']((?:https?:\/\/|\.{0,2}\/)[^"'\s]*\.js)["']/g;
        const literalPaths: string[] = [];
        const literalSeen = new Set<string>();

        for (const m of body.matchAll(literalPattern)) {
            const literalPath = m[1];
            if (!literalSeen.has(literalPath)) {
                literalSeen.add(literalPath);
                literalPaths.push(literalPath);
            }
        }

        // Sapper ships duplicate "modern" and "/legacy/" builds of the same bundle for
        // different browser capability tiers — prefer the modern one when both are found.
        for (const literalPath of literalPaths) {
            if (literalPath.includes("/legacy/") && literalPaths.includes(literalPath.replace("/legacy/", "/"))) {
                continue;
            }
            if (!seen.has(literalPath)) {
                seen.add(literalPath);
                paths.push(literalPath);
            }
        }
    }

    return paths;
};

/**
 * Finds all the lazy loaded JavaScript files from a webpage by parsing the page source.
 * It looks for all `<link>` tags with `rel="modulepreload"` attribute and `<script>` tags with `src` attribute.
 * It then resolves the relative URLs to absolute URLs and returns an array of all the JS files found.
 *
 * @param {string} url - The URL of the webpage to fetch and parse.
 * @returns {Promise<string[]>} - A promise that resolves to an array of absolute URLs pointing to JavaScript files found in the page.
 */
const svelte_getFromPageSource = async (url) => {
    printMsg(MSG.Header, "[i] Analyzing page source");
    const foundUrls = [];
    const pageSource = await makeRequest(url, {});
    const body = await pageSource.text();

    // cheerio to parse the page source
    const $ = cheerio.load(body);

    // find all link tags
    const linkTags = $("link");

    for (const linkTag of linkTags) {
        const relAttr = $(linkTag).attr("rel");
        if (relAttr === "modulepreload") {
            const hrefAttr = $(linkTag).attr("href");
            if (hrefAttr) {
                if (hrefAttr.startsWith("http")) {
                    foundUrls.push(hrefAttr);
                } else {
                    foundUrls.push(await resolvePath(url, hrefAttr));
                }
            }
        }
    }

    // also, parse the script tags
    const scriptTags = $("script");
    for (const scriptTag of scriptTags) {
        const srcAttr = $(scriptTag).attr("src");
        if (srcAttr) {
            if (srcAttr.startsWith("http")) {
                foundUrls.push(srcAttr);
            } else {
                foundUrls.push(await resolvePath(url, srcAttr));
            }
        } else {
            // SvelteKit adapter-node boots the client via an inline <script> block, either via
            // Promise.all([import("./_app/immutable/entry/start.js"), ...]) or a static
            // import { start } from "./_app/immutable/start-<hash>.js" declaration — no src attribute.
            const body = $(scriptTag).html() ?? "";
            for (const importPath of extractInlineScriptJsPaths(body)) {
                if (importPath.startsWith("http")) {
                    foundUrls.push(importPath);
                } else {
                    foundUrls.push(await resolvePath(url, importPath));
                }
            }
        }
    }

    // parse astro-island component-url and renderer-url attributes (Astro island hydration)
    const astroIslands = $("astro-island");
    for (const island of astroIslands) {
        for (const attr of ["component-url", "renderer-url"]) {
            const value = $(island).attr(attr);
            if (value) {
                if (value.startsWith("http")) {
                    foundUrls.push(value);
                } else {
                    foundUrls.push(await resolvePath(url, value));
                }
            }
        }
    }

    if (foundUrls.length === 0) {
        printMsg(MSG.Err, "[!] No JS files found from the page source");
        return [];
    } else {
        printMsg(MSG.Run, `[✓] Found ${foundUrls.length} JS files from the page source`);
    }

    // iterate through the foundUrls and resolve the paths
    for (const foundUrl of foundUrls) {
        if (getJsUrls().includes(foundUrl)) {
            continue;
        }
        pushToJsUrls(foundUrl);
    }

    return foundUrls;
};
export default svelte_getFromPageSource;
