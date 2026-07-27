import chalk from "chalk";
import next_getJSScript from "./next_GetJSScript.js";
import fs from "fs";
import { runWithConcurrency } from "../../utility/concurrency.js";

const next_scriptTagsSubsequentRequests = async (url: string, endpointsFile: string, threads: number = 1) => {
    console.log(chalk.cyan("[i] Getting JS files from subsequent requests (script tags)"));

    let endpoints = JSON.parse(fs.readFileSync(endpointsFile, "utf8")).paths;

    endpoints.push("/");

    // Content-entropy dedup: fetch each endpoint, compute a fingerprint from its
    // script tags, and skip variants whose fingerprint has already been seen.
    // This handles same-path URLs with different query params — if they load the
    // same scripts they are treated as identical; if they load different scripts
    // they are both included.
    const seenFingerprints = new Set<string>();
    let jsUrls: string[] = [];

    const validEndpoints = endpoints.filter((endpoint: string) => /^(\/|https?:\/\/)/.test(endpoint));

    await runWithConcurrency(validEndpoints, threads, async (endpoint: string) => {
        let reqUrl: string;
        try {
            reqUrl = new URL(endpoint, url).href;
        } catch {
            return;
        }
        const scripts = await next_getJSScript(reqUrl);
        const fp = [...new Set(scripts)].sort().join(",");
        if (fp && seenFingerprints.has(fp)) return;
        if (fp) seenFingerprints.add(fp);
        jsUrls.push(...scripts);
    });

    // dedupe
    jsUrls = [...new Set(jsUrls)];

    if (jsUrls.length !== 0) {
        console.log(chalk.green(`[✓] Found ${jsUrls.length} JS files from subsequent requests (script tags)`));
    }

    return jsUrls;
};

export default next_scriptTagsSubsequentRequests;
