import makeRequest from "../../utility/makeReq.js";
import * as cheerio from "cheerio";
import resolvePath from "../../utility/resolvePath.js";
import { getJsUrls, pushToJsUrls } from "../globals.js";
import { printMsg, MSG } from "../../utility/printMsg.js";

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
            // SvelteKit adapter-node boots the client via an inline <script> block using
            // Promise.all([import("./_app/immutable/entry/start.js"), ...]) — no src attribute.
            // Extract the string arguments from every import("...") call in the tag body.
            const body = $(scriptTag).html() ?? "";
            for (const m of body.matchAll(/\bimport\(\s*["']([^"']+\.js)["']\s*\)/g)) {
                const importPath = m[1];
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
