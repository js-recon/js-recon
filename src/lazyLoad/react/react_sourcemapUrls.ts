import makeRequest from "../../utility/makeReq.js";
import chalk from "chalk";
import { runWithConcurrency } from "../../utility/concurrency.js";

const react_sourcemapUrls = async (jsFiles: string[], threads: number = 1): Promise<string[]> => {
    const mapUrls: string[] = [];

    await runWithConcurrency(jsFiles, threads, async (jsUrl) => {
        try {
            const res = await makeRequest(jsUrl, {});
            if (!res) return;
            const body = await res.text();
            const match = body.match(/\/\/# sourceMappingURL=(.+)$/m);
            if (match) {
                const rawRef = match[1].trim();
                const mapUrl: string = new URL(rawRef, jsUrl).href;
                mapUrls.push(mapUrl);
            }
        } catch (_) {
            // skip files that fail to fetch
        }
    });

    if (mapUrls.length > 0) {
        console.log(chalk.green(`[✓] Found ${mapUrls.length} sourcemaps from ${jsFiles.length} JS files`));
    }

    return mapUrls;
};

export default react_sourcemapUrls;
