import path from "path";
import fs from "fs";
import prettier from "prettier";
import makeRequest from "../utility/makeReq.js";
import { getURLDirectory, hostMatchesScope } from "../utility/urlUtils.js";
import { getScope, getMaxReqQueue } from "./globals.js"; // Import scope and max_req_queue functions
import { getSanitizedAssetFilename, resolveAssetOutputDirectory } from "./outputPath.js";
import { getDownloadedAssetKind, readDownloadedAssetResponse } from "./downloadResponse.js";
import * as globalsUtil from "../utility/globals.js";
import { printMsg, MSG } from "../utility/printMsg.js";

/**
 * Downloads the provided JavaScript or JSON URLs and stores them in the given output directory.
 *
 * Each URL is fetched while respecting the configured request queue limits. Files that fall
 * outside the allowed scope are skipped, and downloaded files are formatted before being
 * written to disk.
 *
 * @param {string[]} urls - The list of URLs to download.
 * @param {string} output - The directory where the downloaded JS chunks should be written.
 * @returns {Promise<void>} - Resolves once all eligible files have been downloaded and saved.
 */
// Files larger than this skip Prettier — minified bundles gain nothing from formatting
// and Prettier's internal AST for a 2 MB file can consume hundreds of MB.
const PRETTIER_SIZE_LIMIT = 500 * 1024; // 500 KB

const downloadFiles = async (urls: string[], output: string) => {
    printMsg(MSG.Header, `[i] Attempting to download ${urls.length} JS chunks`);
    fs.mkdirSync(output, { recursive: true });

    const ignoredJSFiles: string[] = [];
    const ignoredJSDomains: string[] = [];
    let download_count = 0;
    let cursor = 0;
    const concurrency = Math.max(1, getMaxReqQueue());

    const processOne = async (url: string) => {
        try {
            if (
                !url.match(/(\.mjs\.map|\.mjs|\.js|\.json|\.js\.map|\.vue|\.tsx?|\.svelte)/) ||
                url.match(/lang\.(css|scss|sass|less|styl)/)
            ) {
                printMsg(MSG.Warn, `[i] Ignored ${url}`);
                return;
            }

            const { rawHost } = getURLDirectory(url);

            if (!hostMatchesScope(rawHost, getScope())) {
                ignoredJSFiles.push(url);
                if (!ignoredJSDomains.includes(rawHost)) {
                    ignoredJSDomains.push(rawHost);
                }
                return;
            }

            let res;
            try {
                res = await makeRequest(url, { reportErrors: true });
            } catch (err) {
                printMsg(MSG.Err, `[!] Failed to download: ${url}`);
                return;
            }

            if (!res) {
                // makeRequest owns the detailed fetch diagnostic.
                return;
            }

            const responseResult = await readDownloadedAssetResponse(url, res);
            if (responseResult.ok === false) {
                const label = responseResult.failure === "invalidResponse" ? "Invalid response" : "Failed to download";
                printMsg(MSG.Err, `[!] ${label}: ${url} : ${responseResult.reason}`);
                return;
            }

            const rawText = responseResult.body;
            const assetKind = getDownloadedAssetKind(url);
            const file = assetKind === "json" ? rawText : `// File Source: ${url}\n${rawText}`;

            const filename = getSanitizedAssetFilename(url);

            if (!filename) {
                printMsg(MSG.Warn, `[!] Could not determine filename for URL: ${url}. Skipping.`);
                return;
            }

            const childDir = resolveAssetOutputDirectory(output, url);
            const filePath = path.join(childDir, filename);
            let formatted: string;
            try {
                if (assetKind === "json") {
                    formatted =
                        file.length <= PRETTIER_SIZE_LIMIT ? await prettier.format(file, { parser: "json" }) : file;
                } else if (assetKind === "vue") {
                    formatted =
                        file.length <= PRETTIER_SIZE_LIMIT ? await prettier.format(file, { parser: "vue" }) : file;
                } else if (assetKind === "typescript") {
                    formatted =
                        file.length <= PRETTIER_SIZE_LIMIT
                            ? await prettier.format(file, { parser: "typescript" })
                            : file;
                } else {
                    formatted =
                        file.length <= PRETTIER_SIZE_LIMIT ? await prettier.format(file, { parser: "babel" }) : file;
                }
            } catch (formatErr) {
                printMsg(MSG.Err, `[!] Failed to format file: ${filePath} : ${formatErr}`);
                return;
            }

            try {
                fs.mkdirSync(childDir, { recursive: true });
                fs.writeFileSync(filePath, formatted);
            } catch (writeErr) {
                if (globalsUtil.getVerbose()) {
                    printMsg(MSG.Err, `[!] Failed to write file: ${filePath} : ${writeErr}`);
                }
                return;
            }
            download_count++;
        } catch (err) {
            printMsg(MSG.Err, `[!] Failed to download: ${url} : ${err}`);
        }
    };

    // Worker pool: each worker processes one file end-to-end before taking the next.
    // This bounds peak memory to (concurrency × largest_file) rather than all files at once.
    const worker = async () => {
        while (true) {
            const idx = cursor++;
            if (idx >= urls.length) break;
            await processOne(urls[idx]);
        }
    };

    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    if (ignoredJSFiles.length > 0) {
        printMsg(
            MSG.Warn,
            `[i] Ignored ${ignoredJSFiles.length} JS files across ${ignoredJSDomains.length} domain(s) - ${ignoredJSDomains.join(", ")}`
        );
    }

    if (download_count > 0) {
        printMsg(MSG.Run, `[✓] Downloaded ${download_count} JS chunks to ${output} directory`);
    }
};

export default downloadFiles;
