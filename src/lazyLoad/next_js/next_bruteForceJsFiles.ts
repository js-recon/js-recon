import makeRequest from "../../utility/makeReq.js";
import { printMsg, MSG } from "../../utility/printMsg.js";

const next_bruteForceJsFiles = async (urls: string[]) => {
    // just append .map to all of them and bruteforce for 200
    printMsg(MSG.Header, "[i] Bruteforcing .map files");
    const mapFiles = urls.map((url) => url + ".map");

    let foundSourceMaps: string[] = [];

    for (const mapFile of mapFiles) {
        const req = await makeRequest(mapFile);

        if (req) {
            const status = req.status;

            if (status === 200) {
                foundSourceMaps.push(mapFile);
            }
        } else {
            printMsg(MSG.Err, `[!] Failed to request ${mapFile}`);
        }
    }

    if (foundSourceMaps.length === 0) {
        printMsg(MSG.Err, "[!] No source maps found");
        return foundSourceMaps;
    }

    printMsg(MSG.Run, `[✓] Found ${foundSourceMaps.length} source maps`);
    return foundSourceMaps;
};

export default next_bruteForceJsFiles;
