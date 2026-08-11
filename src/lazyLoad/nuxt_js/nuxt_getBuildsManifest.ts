import makeRequest from "../../utility/makeReq.js";
import { printMsg, MSG } from "../../utility/printMsg.js";

/**
 * Discovers Nuxt's build manifest JSON files.
 *
 * Nuxt 3 serves two manifest files under `/_nuxt/builds/`:
 *   - `latest.json`          — points to the current build ID
 *   - `meta/<buildId>.json`  — per-build asset manifest
 *
 * Neither is referenced from the HTML page source; both are fetched at runtime
 * by the Nuxt client to support incremental deployments. This method probes them
 * explicitly so they are included in the download output.
 *
 * @param url - The base URL of the Nuxt app (origin is used).
 * @returns Array of absolute URLs for the manifest files that exist.
 */
const nuxt_getBuildsManifest = async (url: string): Promise<string[]> => {
    const origin = new URL(url).origin;
    const latestUrl = `${origin}/_nuxt/builds/latest.json`;
    const found: string[] = [];

    let buildId: string | undefined;
    try {
        const res = await makeRequest(latestUrl, {});
        if (res) {
            const text = await res.text();
            found.push(latestUrl);
            const parsed = JSON.parse(text);
            if (parsed && typeof parsed.id === "string") {
                buildId = parsed.id;
            }
        }
    } catch {
        // latest.json not present — not a Nuxt 3 app or not deployed with build manifests
        return found;
    }

    if (buildId) {
        const metaUrl = `${origin}/_nuxt/builds/meta/${buildId}.json`;
        try {
            const res = await makeRequest(metaUrl, {});
            if (res) {
                found.push(metaUrl);
            }
        } catch {
            // meta file not available
        }
    }

    if (found.length > 0) {
        printMsg(MSG.Run, `[✓] Found ${found.length} Nuxt build manifest file(s)`);
    }

    return found;
};

export default nuxt_getBuildsManifest;
