import makeRequest from "../../utility/makeReq.js";
import chalk from "chalk";
import { runWithConcurrency } from "../../utility/concurrency.js";

const next_bruteForceJsFiles = async (urls: string[], threads: number = 1) => {
    // just append .map to all of them and bruteforce for 200
    console.log(chalk.cyan("[i] Bruteforcing .map files"));
    const mapFiles = urls.map((url) => url + ".map");

    let foundSourceMaps: string[] = [];

    await runWithConcurrency(mapFiles, threads, async (mapFile) => {
        const req = await makeRequest(mapFile);

        if (req) {
            const status = req.status;

            if (status === 200) {
                foundSourceMaps.push(mapFile);
            }
        } else {
            console.error(chalk.red(`[!] Failed to request ${mapFile}`));
        }
    });

    if (foundSourceMaps.length === 0) {
        console.error(chalk.red("[!] No source maps found"));
        return foundSourceMaps;
    }

    console.log(chalk.green(`[✓] Found ${foundSourceMaps.length} source maps`));
    return foundSourceMaps;
};

export default next_bruteForceJsFiles;
