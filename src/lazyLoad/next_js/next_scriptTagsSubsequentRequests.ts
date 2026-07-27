import { printMsg, MSG } from "../../utility/printMsg.js";
import next_getJSScript from "./next_GetJSScript.js";
import fs from "fs";

const next_scriptTagsSubsequentRequests = async (url: string, endpointsFile: string) => {
    printMsg(MSG.Header, "[i] Getting JS files from subsequent requests (script tags)");

    let endpoints = JSON.parse(fs.readFileSync(endpointsFile, "utf8")).paths;

    endpoints.push("/");

    // Content-entropy dedup: fetch each endpoint, compute a fingerprint from its
    // script tags, and skip variants whose fingerprint has already been seen.
    // This handles same-path URLs with different query params — if they load the
    // same scripts they are treated as identical; if they load different scripts
    // they are both included.
    const seenFingerprints = new Set<string>();
    let jsUrls: string[] = [];

    for (const endpoint of endpoints) {
        // skip anything that isn't a valid relative path or absolute URL
        if (!/^(\/|https?:\/\/)/.test(endpoint)) continue;

        let reqUrl: string;
        try {
            reqUrl = new URL(endpoint, url).href;
        } catch {
            continue;
        }
        const scripts = await next_getJSScript(reqUrl);
        const fp = [...new Set(scripts)].sort().join(",");
        if (fp && seenFingerprints.has(fp)) continue;
        if (fp) seenFingerprints.add(fp);
        jsUrls.push(...scripts);
    }

    // dedupe
    jsUrls = [...new Set(jsUrls)];

    if (jsUrls.length !== 0) {
        printMsg(MSG.Run, `[✓] Found ${jsUrls.length} JS files from subsequent requests (script tags)`);
    }

    return jsUrls;
};

export default next_scriptTagsSubsequentRequests;
