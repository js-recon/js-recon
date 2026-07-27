import chalk from "chalk";
import cliProgress from "cli-progress";
import makeRequest from "../../utility/makeReq.js";
import { setActiveBarLogger, computeBarSize, watchBarResize } from "../../utility/progressLog.js";
import parser from "@babel/parser";
import { extractStrings } from "../../strings/index.js";
import { runWithConcurrency } from "../../utility/concurrency.js";

/**
 * Resolves a .js string found in a bundle to an absolute URL.
 *
 * Handles three forms:
 *   - `./Feature.hash.js` or `../chunk.js`  → standard relative resolution
 *   - `/static/chunk.js`                     → absolute path on same origin
 *   - `assets/feat.hash.js`                  → find where "assets" appears in
 *     the JS file's URL path and anchor there
 */
const resolveJsString = (str: string, jsFileUrl: string): string | null => {
    try {
        if (str.startsWith("http://") || str.startsWith("https://")) {
            return new URL(str).href;
        }

        const fileUrl = new URL(jsFileUrl);

        if (str.startsWith("./") || str.startsWith("../")) {
            return new URL(str, jsFileUrl).href;
        }

        if (str.startsWith("/")) {
            return new URL(str, fileUrl.origin).href;
        }

        // Relative path without a leading dot, e.g. "assets/feat.hash.js"
        const strParts = str.split("/");
        const strDirParts = strParts.slice(0, -1); // directory segments of the string

        if (strDirParts.length === 0) {
            // bare filename — resolve relative to the JS file's directory
            const dirUrl = jsFileUrl.substring(0, jsFileUrl.lastIndexOf("/") + 1);
            return dirUrl + str;
        }

        // urlPathParts: e.g. ['cdn', 'assets', 'app.js'] for /cdn/assets/app.js
        const urlPathParts = fileUrl.pathname.split("/").filter((p) => p);

        // Find the rightmost occurrence of strDirParts[0] in the URL path, then
        // verify the subsequent segments also match before committing.
        for (let i = urlPathParts.length - 1; i >= 0; i--) {
            if (urlPathParts[i] !== strDirParts[0]) continue;

            let match = true;
            for (let j = 1; j < strDirParts.length; j++) {
                if (urlPathParts[i + j] !== strDirParts[j]) {
                    match = false;
                    break;
                }
            }

            if (match) {
                const baseParts = urlPathParts.slice(0, i);
                const basePath = "/" + (baseParts.length > 0 ? baseParts.join("/") + "/" : "");
                return fileUrl.origin + basePath + str;
            }
        }

        // Fallback: treat as relative to the JS file's directory
        const dirUrl = jsFileUrl.substring(0, jsFileUrl.lastIndexOf("/") + 1);
        return dirUrl + str;
    } catch {
        return null;
    }
};

const fetchAndExtractJsStrings = async (url: string, maxJsSizeMb: number): Promise<Set<string>> => {
    const MAX_BYTES = maxJsSizeMb * 1024 * 1024;
    const found = new Set<string>();

    const req = await makeRequest(url);
    if (req == null) return found;

    const text = await req.text();
    if (text.length > MAX_BYTES) return found;

    let ast: any;
    try {
        ast = parser.parse(text, {
            sourceType: "unambiguous",
            plugins: ["jsx", "typescript"],
            errorRecovery: true,
        });
    } catch {
        return found;
    }

    const strings = extractStrings(ast);

    for (const s of strings) {
        if (!s.endsWith(".js")) continue;

        const resolved = resolveJsString(s, url);
        if (resolved) found.add(resolved);
    }

    return found;
};

/**
 * Discovers additional JS chunk URLs by scanning string literals inside every
 * known JS file for references that end in `.js` and resolving them against
 * the file's own URL.
 */
const vue_stringJsFiles = async (
    knownJsFiles: string[],
    maxJsSizeMb: number = 2,
    threads: number = 1
): Promise<string[]> => {
    const allFound = new Set<string>();
    const crawled = new Set<string>(knownJsFiles);

    const bar = new cliProgress.SingleBar(
        {
            format:
                chalk.cyan("[i] Scanning JS string refs ") +
                "[{bar}] {percentage}% | {value}/{total} files | {refs} refs found",
            barCompleteChar: "█",
            barIncompleteChar: "░",
            barsize: computeBarSize(72),
            hideCursor: false,
            clearOnComplete: false,
            stopOnComplete: false,
        },
        cliProgress.Presets.shades_classic
    );

    let processed = 0;
    let totalKnown = knownJsFiles.length;

    bar.start(totalKnown, 0, { refs: 0 });
    const stopBarWatcher = watchBarResize(bar, 72);
    setActiveBarLogger({ log: (s: string) => process.stdout.write("\r\x1b[K" + s) });

    const processFile = async (url: string, newFiles: string[]) => {
        const discovered = await fetchAndExtractJsStrings(url, maxJsSizeMb);
        for (const u of discovered) {
            allFound.add(u);
            if (!crawled.has(u)) {
                crawled.add(u);
                newFiles.push(u);
                totalKnown++;
                bar.setTotal(totalKnown);
            }
        }
        processed++;
        bar.update(processed, { refs: allFound.size });
    };

    // Fixpoint discovery, processed in rounds: each round's batch is fetched
    // concurrently, and any newly-discovered files seed the next round.
    let currentBatch = [...knownJsFiles];
    while (currentBatch.length > 0) {
        const newFiles: string[] = [];
        await runWithConcurrency(currentBatch, threads, (url) => processFile(url, newFiles));
        currentBatch = newFiles;
    }

    bar.stop();
    stopBarWatcher();
    setActiveBarLogger(null);

    return [...allFound];
};

export default vue_stringJsFiles;
