import path from "path";
import fs from "fs";
import crypto from "crypto";
import makeRequest from "../../utility/makeReq.js";
import { getURLDirectory } from "../../utility/urlUtils.js";
import * as lazyLoadGlobals from "../globals.js";
import { printMsg, MSG } from "../../utility/printMsg.js";

/**
 * Synthesizes an on-disk filename for a generic-tech JS URL. downloadFilesUtil.ts's
 * regex expects the LAST path segment to already be a clean ".js"/".mjs" filename,
 * which breaks for content-type-confirmed assets like ".../beacon.min.js/v124/token"
 * (the ".js" segment isn't the last one) — hence a dedicated synthesis step here.
 */
export const synthesizeFilename = (url: string): string => {
    const hash = crypto.createHash("sha1").update(url).digest("hex").slice(0, 8);
    const pathname = new URL(url).pathname;
    const segments = pathname.split("/").filter(Boolean);
    const lastSegment = segments[segments.length - 1] ?? "";

    if (/^[a-zA-Z0-9.\-_]+\.(mjs|js)$/.test(lastSegment)) {
        return lastSegment;
    }

    for (let i = segments.length - 1; i >= 0; i--) {
        if (segments[i].toLowerCase().endsWith(".js")) {
            return `${segments[i].replace(/\.js$/i, "")}-${hash}.js`;
        }
    }

    return `${hash}.js`;
};

const generic_downloadFiles = async (urls: string[], output: string, threads: number): Promise<void> => {
    if (urls.length === 0) return;

    printMsg(MSG.Header, `[i] Attempting to download ${urls.length} generic JS file(s)`);

    let downloadCount = 0;
    let cursor = 0;
    const concurrency = Math.max(1, threads);

    const processOne = async (url: string) => {
        try {
            const { host, directory } = getURLDirectory(url);
            const childDir = path.join(output, host, directory);
            fs.mkdirSync(childDir, { recursive: true });

            const res = await makeRequest(url, {});
            if (!res) {
                printMsg(MSG.Err, `[!] Failed to download: ${url}`);
                return;
            }

            const rawText = await res.text();
            const filename = synthesizeFilename(url);
            const filePath = path.join(childDir, filename);
            fs.writeFileSync(filePath, `// File Source: ${url}\n${rawText}`);
            lazyLoadGlobals.recordJsFileHash(crypto.createHash("sha256").update(rawText).digest("hex"));
            downloadCount++;
        } catch (err) {
            printMsg(MSG.Err, `[!] Failed to download: ${url} : ${err}`);
        }
    };

    const worker = async () => {
        while (true) {
            const idx = cursor++;
            if (idx >= urls.length) break;
            await processOne(urls[idx]);
        }
    };

    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    if (downloadCount > 0) {
        printMsg(MSG.Run, `[✓] Downloaded ${downloadCount} generic JS file(s) to ${output} directory`);
    }
};

export default generic_downloadFiles;
