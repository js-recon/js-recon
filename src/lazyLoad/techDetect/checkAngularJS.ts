import * as cheerio from "cheerio";
import makeRequest from "../../utility/makeReq.js";

const checkAngularJS = async ($: cheerio.CheerioAPI, url: string) => {
    let detected = false;
    let evidence = "";

    // Fast path: HTML-level Angular signals that require no extra network request.
    // data-beasties-container is added by Angular's Beasties SSR/prerendering package.
    if ($("html[data-beasties-container]").length > 0) {
        return { detected: true, evidence: "data-beasties-container" };
    }

    // ng-version is set by the Angular runtime on the root component element after
    // bootstrapping. Present only in the Puppeteer-rendered DOM, not raw static HTML.
    const ngVersionEl = $("[ng-version]");
    if (ngVersionEl.length > 0) {
        const ver = ngVersionEl.attr("ng-version");
        return { detected: true, evidence: `ng-version="${ver}"` };
    }

    // Angular view encapsulation adds _nghost-* attributes to host elements.
    // This is reliable for rendered pages (Puppeteer) but absent in raw HTML.
    const ngHostEl = $("[class]").filter((_, el) => {
        const cls = $(el).attr("class") || "";
        return /_nghost-/.test(cls);
    });
    if (ngHostEl.length > 0) {
        return { detected: true, evidence: "_nghost-* view encapsulation attribute" };
    }

    // Second pass: look for main.js or main-HASH.js in script src and check its content
    // for Angular runtime patterns. Matches both production (hashed) and development builds.
    let hasMainJs = false;
    let mainJsURL: string | undefined = undefined;
    $("script").each((_, el) => {
        const attribs = el.attribs;
        if (attribs) {
            for (const [attrName, attrValue] of Object.entries(attribs)) {
                if (attrName === "src") {
                    // Match main.js (dev builds) and main-HASH.js (production builds)
                    // eslint-disable-next-line security/detect-unsafe-regex -- anchored at $, bounded groups — not exploitable
                    if (/(?:^|\/)main(-[a-zA-Z0-9]+)?\.js(\?.*)?$/.test(attrValue)) {
                        hasMainJs = true;

                        if (!attrValue.startsWith("http")) {
                            mainJsURL = new URL(attrValue, url).href;
                        } else {
                            mainJsURL = attrValue;
                        }
                    }
                }
            }
        }
    });

    // now, get the contents of the main.js file
    if (hasMainJs) {
        const mainJsRes = await makeRequest(mainJsURL, {});
        const mainJsBody = await mainJsRes.text();

        // check if the traces of angular js are present
        // using regex for this, as this is simple and fast

        // Zone.js patterns (present in Zone.js-based Angular apps)
        const isAngularZoneRegex = /isAngularZone\(\)/;
        const isAngularZoneRegex2 = /"isAngularZone"/;
        const ngZoneRegex = /this\.ngZone/;
        // Angular router pattern
        const routerLinkRegex = /"routerLink"/;

        if (isAngularZoneRegex.test(mainJsBody)) {
            detected = true;
            evidence = "isAngularZone()";
        } else if (isAngularZoneRegex2.test(mainJsBody)) {
            detected = true;
            evidence = '"isAngularZone"';
        } else if (ngZoneRegex.test(mainJsBody)) {
            detected = true;
            evidence = "this.ngZone";
        } else if (routerLinkRegex.test(mainJsBody)) {
            detected = true;
            evidence = "routerLink";
        }
    }

    return { detected, evidence };
};

export { checkAngularJS };
