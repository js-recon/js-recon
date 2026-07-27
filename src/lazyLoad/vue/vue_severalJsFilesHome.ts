import makeRequest from "../../utility/makeReq.js";
import * as cheerio from "cheerio";
import { printMsg, MSG } from "../../utility/printMsg.js";
const vue_severalJsFilesHome = async (url: string): Promise<string[]> => {
    let jsFilesToReturn: string[] = [];

    // get the contents of the homepage
    const homepageReq = await makeRequest(url);
    if (homepageReq == null) {
        printMsg(MSG.Err, `Failed to fetch ${url}`);
        return jsFilesToReturn;
    }
    const homepageContent = await homepageReq.text();

    // parse it with cheerio
    const $ = cheerio.load(homepageContent);

    // find all the script tag urls
    const scriptTags = $("script");

    // iterate through those, and find the ones that aren't CDN URLs, like the relative or absolute paths
    let jsPaths: string[] = [];
    for (const tag of scriptTags) {
        const src = $(tag).attr("src");
        if (src && !src.startsWith("http")) {
            jsPaths.push(src);
        }
    }

    // if length is 1, return
    if (jsPaths.length === 1) {
        return jsFilesToReturn;
    }

    // apart from script tags, also go through the <link> tags, check if the `href` attr of those end with `.js`, and if so, push it to the list of the JS paths
    const linkTags = $("link");
    for (const tag of linkTags) {
        const src = $(tag).attr("href");
        if (src && !src.startsWith("http") && src.endsWith(".js")) {
            jsPaths.push(src);
        }
    }

    // now that there are files, go through those and get the full path of those
    let fullJsUrls: string[] = [];
    for (const path of jsPaths) {
        const fullUrl = new URL(path, url).href;
        fullJsUrls.push(fullUrl);
    }

    // push these to the list of the JS files to return
    jsFilesToReturn.push(...fullJsUrls);

    return jsFilesToReturn;
};

export default vue_severalJsFilesHome;
