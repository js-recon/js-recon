import makeRequest from "../../utility/makeReq.js";
import { getJsUrls, pushToJsUrls } from "../globals.js";
import * as cheerio from "cheerio";
import { printMsg, MSG } from "../../utility/printMsg.js";

/**
 * Finds all the lazy loaded JavaScript files from a webpage by parsing the page source.
 * It looks for all `<link>` tags with `as="script"` attribute and `<script>` tags with `src` attribute.
 * It then resolves the relative URLs to absolute URLs and returns an array of all the JS files found.
 *
 * @param {string} url - The URL of the webpage to fetch and parse.
 * @returns {Promise<string[]>} - A promise that resolves to an array of absolute URLs pointing to JavaScript files found in the page.
 */
const nuxt_getFromPageSource = async (url) => {
    printMsg(MSG.Header, "[i] Analyzing page source");

    const urlCountBefore = getJsUrls().length;

    // get the page source
    const res = await makeRequest(url, {});
    const pageSource = await res.text();

    // cheerio to parse the page source
    const $ = cheerio.load(pageSource);

    // find all link tags
    const linkTags = $("link");

    // go through them, and find the ones which have `as=script` attr
    for (const linkTag of linkTags) {
        const asAttr = $(linkTag).attr("as");
        if (asAttr === "script") {
            const hrefAttr = $(linkTag).attr("href");
            if (hrefAttr) {
                // see if it starts with /_nuxt
                if (hrefAttr.startsWith("/_nuxt")) {
                    // get the URL root, and append the hrefAttr to it
                    const urlRoot = new URL(url).origin;
                    pushToJsUrls(urlRoot + hrefAttr);
                }
            }
        }
    }

    // now, search all the script tags
    const scriptTags = $("script");
    for (const scriptTag of scriptTags) {
        const src = $(scriptTag).attr("src");
        if (src !== undefined && src.match(/(https:\/\/[a-zA-Z0-9_\_\.]+\/.+\.js\??.*|\/.+\.js\??.*)/)) {
            if (src.startsWith("http")) {
                if (!getJsUrls().includes(src)) {
                    pushToJsUrls(src);
                }
            }
            // if the src starts with /, like `/static/js/a.js` find the absolute URL
            else if (src.startsWith("/")) {
                const absoluteUrl = new URL(url).origin + src;
                if (!getJsUrls().includes(absoluteUrl)) {
                    pushToJsUrls(absoluteUrl);
                }
            } else if (src.match(/^[^/]/)) {
                // if the src is a relative URL, like `static/js/a.js` find the absolute URL
                // Get directory URL (origin + path without filename)
                const pathParts = new URL(url).pathname.split("/");
                pathParts.pop(); // remove the filename from the path
                const directory = new URL(url).origin + pathParts.join("/") + "/";

                if (!getJsUrls().includes(directory + src)) {
                    pushToJsUrls(directory + src);
                }
            } else {
                continue;
            }
        }
    }

    const newUrlCount = getJsUrls().length - urlCountBefore;
    printMsg(MSG.Run, `[✓] Found ${newUrlCount} JS files from the page source`);

    return getJsUrls();
};

export default nuxt_getFromPageSource;
