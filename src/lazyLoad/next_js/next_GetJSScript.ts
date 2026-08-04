// lazyLoad/nextGetJSScript.js
import { printMsg, MSG } from "../../utility/printMsg.js";
import { URL } from "url";
import * as cheerio from "cheerio";
import makeRequest from "../../utility/makeReq.js";
import { getJsUrls } from "../globals.js";
import { getCacheOnly } from "../../utility/globals.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Scrapes all lazy-loaded JavaScript file URLs from the provided Next.js page.
 *
 * The function fetches the HTML with `makeRequest`, parses `script` tags via `cheerio`,
 * and normalizes discovered `src` attributes (absolute, relative, or inline chunk hints)
 * into absolute URLs using the shared lazy-load URL registry.
 *
 * @param {string} url - The URL of the webpage to fetch and parse.
 * @returns {Promise<string[]>} - A promise that resolves to an array of absolute URLs
 * pointing to JavaScript files found in the page.
 */
const MAX_FETCH_ATTEMPTS = 5;

const next_getJSScript = async (url: string): Promise<string[]> => {
    const toReturn: string[] = [];
    // get the page source — bounded retry so an unreachable host can't hang the crawler
    let res: Response | null = null;
    const maxAttempts = getCacheOnly() ? 1 : MAX_FETCH_ATTEMPTS;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        res = await makeRequest(url, {});
        if (res) break;
        if (attempt < maxAttempts) {
            printMsg(MSG.Warn, `[!] Request to ${url} failed, retrying (${attempt}/${maxAttempts})...`);
            await sleep(1000);
        }
    }
    if (!res) {
        if (!getCacheOnly()) {
            printMsg(MSG.Err, `[!] Giving up on ${url} after ${maxAttempts} attempts`);
        }
        return toReturn;
    }
    const pageSource = await res.text();

    // cheerio to parse the page source
    const $ = cheerio.load(pageSource);

    // find all script tags
    const scriptTags = $("script");

    // iterate through script tags
    for (const scriptTag of scriptTags) {
        // get the src attribute
        const src = $(scriptTag).attr("src");

        // see if the src is a JS file
        if (src !== undefined && src.match(/(https:\/\/[a-zA-Z0-9_\_\.]+\/.+\.js\??.*|\/.+\.js\??.*)/)) {
            // if the src starts with /, like `/static/js/a.js` find the absolute URL
            if (src.startsWith("/")) {
                const absoluteUrl = new URL(url).origin + src;
                if (!getJsUrls().includes(absoluteUrl)) {
                    toReturn.push(absoluteUrl);
                }
            } else if (src.startsWith("http")) {
                const urlObj = new URL(src);
                const ext = urlObj.pathname.split(".").pop();
                if (ext === "js") {
                    if (!getJsUrls().includes(src)) {
                        toReturn.push(src);
                    }
                }
            } else if (src.match(/^[^/]/)) {
                // if the src is a relative URL, like `static/js/a.js` find the absolute URL
                // Get directory URL (origin + path without filename)
                const pathParts = new URL(url).pathname.split("/");
                pathParts.pop(); // remove filename from last
                const directory = new URL(url).origin + pathParts.join("/") + "/";

                if (!getJsUrls().includes(directory + src)) {
                    toReturn.push(directory + src);
                }
            } else {
                if (!getJsUrls().includes(src)) {
                    toReturn.push(src);
                }
            }
        } else {
            // if the script tag is inline, it could contain static JS URL
            // to get these, simply regex from the JS script

            const js_script = $(scriptTag).html();
            const matches = js_script?.match(/static\/chunks\/[a-zA-Z0-9_\-~.]+\.js/g);

            if (matches) {
                const uniqueMatches = [...new Set(matches)];
                for (const match of uniqueMatches) {
                    // if it is using that static/chunks/ pattern, I can just get the filename
                    const filename = match.replace("static/chunks/", "");

                    // go through the already found URLs, coz they will have it (src attribute
                    // is there before inline things)

                    let js_path_dir;

                    for (const js_url of getJsUrls()) {
                        if (
                            !js_path_dir &&
                            new URL(js_url).host === new URL(url).host &&
                            new URL(js_url).pathname.includes("static/chunks/")
                        ) {
                            js_path_dir = js_url.replace(/\/[^\/]+\.js.*$/, "");
                        }
                    }
                    if (js_path_dir) {
                        // Ensure js_path_dir was found
                        toReturn.push(js_path_dir + "/" + filename);
                    }
                }
            }
        }
    }

    // causes too much noise after using it with subsequent requests
    // console.log(chalk.green(`[✓] Found ${getJsUrls().length} JS files from the script tags`));

    return toReturn;
};

export default next_getJSScript;
