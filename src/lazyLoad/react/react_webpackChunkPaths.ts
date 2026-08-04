import makeRequest from "../../utility/makeReq.js";
import { runWithConcurrency } from "../../utility/concurrency.js";
import { extractWebpackChunkUrls } from "../shared/webpackChunkParsers.js";
import { printMsg, MSG } from "../../utility/printMsg.js";

export const deduplicateWebpackChunkPaths = (paths: readonly string[]): string[] => [...new Set(paths)];

// url param kept for API consistency with other react_* functions
const react_webpackChunkPaths = async (
    _url: string,
    maxJsSizeMb: number,
    jsFiles: string[],
    threads: number = 1
): Promise<string[]> => {
    let toReturn: string[] = [];

    await runWithConcurrency(jsFiles, threads, async (jsFile) => {
        try {
            const req = await makeRequest(jsFile);

            if (!req || req.status !== 200) return;

            const contentLength = req.headers.get("content-length");
            if (contentLength && parseInt(contentLength) > maxJsSizeMb * 1024 * 1024) {
                printMsg(MSG.Warn, `[!] Skipping ${jsFile} (too large)`);
                return;
            }

            const jsContent = await req.text();

            if (jsContent.length > maxJsSizeMb * 1024 * 1024) {
                printMsg(MSG.Warn, `[!] Skipping ${jsFile} (too large)`);
                return;
            }

            const urls = extractWebpackChunkUrls(jsContent, jsFile);
            if (urls.length > 0) {
                printMsg(MSG.Run, `[✓] Found ${urls.length} webpack chunk JS file(s) in ${jsFile}`);
                toReturn.push(...urls);
            }
        } catch (err) {
            printMsg(MSG.Err, `[!] Error processing ${jsFile}: ${err}`);
        }
    });

    toReturn = deduplicateWebpackChunkPaths(toReturn);
    if (toReturn.length > 0) {
        printMsg(MSG.Run, `[✓] Found ${toReturn.length} webpack chunk JS files`);
    }

    return toReturn;
};

export default react_webpackChunkPaths;
