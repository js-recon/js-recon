import makeRequest from "../../utility/makeReq.js";
import chalk from "chalk";
import * as cheerio from "cheerio";
import { progressError } from "../../utility/progressLog.js";

const vue_pageSrc = async (url: string) => {
    const toReturn: string[] = [];

    // first, get the contents of the homepage
    const req = await makeRequest(url);
    if (req == null) {
        progressError(chalk.red(`Failed to fetch ${url}`));
        return toReturn;
    }
    const homepageContent = await req.text();

    // get all the script srcs
    const $script = cheerio.load(homepageContent);
    $script("script").each((_, el) => {
        const src = $script(el).attr("src");
        if (src) {
            // construct the full URL if it's a relative path
            if (src.startsWith("http") || src.startsWith("//")) {
                toReturn.push(src);
            } else {
                const fullUrl = new URL(src, url).href;
                toReturn.push(fullUrl);
            }
        }
    });

    // get all the link srcs
    const $link = cheerio.load(homepageContent);
    $link("link").each((_, el) => {
        const src = $link(el).attr("href");
        if (src) {
            // check the rel attribute
            const rel = $link(el).attr("rel");
            const asAttr = $link(el).attr("as");
            if (rel && (rel == "modulepreload" || (rel == "preload" && asAttr == "script"))) {
                // construct the full URL if it's a relative path
                if (src.startsWith("http") || src.startsWith("//")) {
                    toReturn.push(src);
                } else {
                    const fullUrl = new URL(src, url).href;
                    toReturn.push(fullUrl);
                }
            }
        }
    });

    return toReturn;
};

export default vue_pageSrc;
