import makeRequest from "../../utility/makeReq.js";
import * as cheerio from "cheerio";
import resolvePath from "../../utility/resolvePath.js";
import { printMsg, MSG } from "../../utility/printMsg.js";

const angular_getFromPageSource = async (url: string) => {
    printMsg(MSG.Header, "[i] Analyzing page source");

    const foundUrls: string[] = [];

    const pageSource = await makeRequest(url, {});
    const body = await pageSource.text();

    // cheerio to parse the page source
    const $ = cheerio.load(body);

    // find all the script tags
    const scriptTags = $("script");
    for (const scriptTag of scriptTags) {
        const srcAttr = $(scriptTag).attr("src");
        if (srcAttr) {
            // if it starts with http, then push it directly. if no, then resolve it
            if (srcAttr.startsWith("http")) {
                foundUrls.push(srcAttr);
            } else if (srcAttr.startsWith("//")) {
                // get the url protocol and use that
                const protocol = url.split(":")[0];
                foundUrls.push(protocol + srcAttr);
            } else {
                foundUrls.push(await resolvePath(url, srcAttr));
            }
        }
    }

    return foundUrls;
};

export default angular_getFromPageSource;
