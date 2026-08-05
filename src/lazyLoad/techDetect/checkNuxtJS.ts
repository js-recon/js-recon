import * as cheerio from "cheerio";

/**
 * Detects if a webpage uses Nuxt.js by checking for "/_nuxt" paths in src or href attributes.
 *
 * @param $ - The Cheerio API object containing the parsed HTML
 * @returns Promise that resolves to an object with detection status and evidence
 */
export const checkNuxtJS = async ($: cheerio.CheerioAPI) => {
    let detected = false;
    let evidence = "";

    // go through the page source, and check for "/_nuxt" in the src or href attribute
    $("*").each((_, el) => {
        // @ts-expect-error -- cheerio's Element type doesn't expose tagName in this overload
        const tag = $(el).get(0).tagName;
        // @ts-expect-error -- cheerio's Element type doesn't expose attribs in this overload
        const attribs = el.attribs;
        if (attribs) {
            for (const [attrName, attrValue] of Object.entries(attribs)) {
                if (attrName === "src" || attrName === "href") {
                    // @ts-expect-error -- attribs value type is untyped in this cheerio overload
                    if (attrValue.includes("/_nuxt")) {
                        detected = true;
                        evidence = `${attrName} :: ${attrValue}`;
                    }
                }
            }
        }
    });

    return { detected, evidence };
};
