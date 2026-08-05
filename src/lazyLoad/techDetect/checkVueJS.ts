import makeRequest from "../../utility/makeReq.js";
import * as cheerio from "cheerio";

/**
 * Checks if a webpage uses Vue.js by iterating through all HTML tags and checking if any attribute name starts with "data-v-".
 * @returns {Promise<{detected: boolean, evidence: string}>}
 *   A promise that resolves to an object with two properties:
 *   - detected: A boolean indicating whether Vue.js was detected.
 *   - evidence: A string with the evidence of the detection, or an empty string
 *     if Vue.js was not detected.
 */
const checkVueJS = async ($, url: string) => {
    let detected = false;
    let evidence = "";

    $("*").each((_, el) => {
        const tag = $(el).get(0).tagName;
        const attribs = el.attribs;
        if (attribs) {
            for (const [attrName, attrValue] of Object.entries(attribs)) {
                if (attrName.startsWith("data-v-")) {
                    detected = true;
                    evidence = `${tag} :: ${attrName}`;
                } else if (attrName.startsWith("data-vue-")) {
                    detected = true;
                    evidence = `${tag} :: ${attrName}`;
                }
            }
        }
    });
    if (detected) {
        return { detected, evidence };
    }

    // now, iterate through all the script tags, and find something like `app.js`
    let appJsURL: string | undefined;
    $("script").each((_, el) => {
        const tag = $(el).get(0).tagName;
        const attribs = el.attribs;
        if (attribs) {
            for (const [attrName, attrValue] of Object.entries(attribs)) {
                if (attrName === "src") {
                    // @ts-expect-error -- attribs value type is untyped in this cheerio overload
                    if (attrValue.includes("app.js")) {
                        // get the URL of the app.js file
                        // @ts-expect-error -- attribs value type is untyped in this cheerio overload
                        if (attrValue.startsWith("/")) {
                            // @ts-expect-error -- attribs value type is untyped in this cheerio overload
                            appJsURL = new URL(attrValue, url).href;
                            // @ts-expect-error -- attribs value type is untyped in this cheerio overload
                        } else if (attrValue.startsWith("http")) {
                            // @ts-expect-error -- attribs value type is untyped in this cheerio overload
                            appJsURL = attrValue;
                        } else {
                            // @ts-expect-error -- attribs value type is untyped in this cheerio overload
                            appJsURL = new URL(attrValue, url).href;
                        }
                    }
                }
            }
        }
    });

    if (appJsURL) {
        const appJsContent: string = await makeRequest(appJsURL).then((res) => res.text());
        if (appJsContent) {
            if (appJsContent.includes("Vue.component(")) {
                detected = true;
                evidence = `${appJsURL} :: Vue.component()`;
            }
        }
    }

    if (detected) {
        return { detected, evidence };
    }

    // collect script[src] and link[rel="modulepreload"][href] URLs
    const assetURLs: string[] = [];
    $("script[src]").each((_: number, el: import("domhandler").AnyNode) => {
        const src = $(el).attr("src");
        if (src) {
            try {
                assetURLs.push(new URL(src, url).href);
            } catch {}
        }
    });
    $('link[rel="modulepreload"][href]').each((_: number, el: import("domhandler").AnyNode) => {
        const href = $(el).attr("href");
        if (href) {
            try {
                assetURLs.push(new URL(href, url).href);
            } catch {}
        }
    });

    // Only scan same-origin assets here. Third-party widgets (analytics, tag
    // managers, ad SDKs) are numerous and often slow/unreachable, and scanning
    // their content for "__vue" also risks false positives on sites that don't
    // use Vue themselves.
    const pageOrigin = new URL(url).origin;
    for (const assetURL of assetURLs) {
        try {
            if (new URL(assetURL).origin !== pageOrigin) continue;
            const res = await makeRequest(assetURL);
            if (!res) continue;
            const content: string = await res.text();
            if (content && content.toLowerCase().includes("__vue")) {
                return { detected: true, evidence: `__vue in ${assetURL}` };
            }
        } catch {}
    }

    return { detected, evidence };
};

export { checkVueJS };
