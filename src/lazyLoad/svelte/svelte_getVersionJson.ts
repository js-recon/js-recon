import makeRequest from "../../utility/makeReq.js";
import resolvePath from "../../utility/resolvePath.js";
import { printMsg, MSG } from "../../utility/printMsg.js";

/**
 * Probes the SvelteKit-specific version.json endpoint.
 *
 * SvelteKit serves `/<appDir>/version.json` to let clients detect new deployments
 * (via the `updated` store). This file is never referenced in page HTML or JS source,
 * so string analysis and link/script tag scanning both miss it. It must be probed
 * directly once the framework is identified and the appDir is known.
 *
 * @param baseUrl - The base URL of the target app
 * @param appDir  - SvelteKit's appDir (default: "_app")
 * @returns Array containing the version.json URL if the endpoint responds 200, otherwise empty
 */
const svelte_getVersionJson = async (baseUrl: string, appDir: string = "_app"): Promise<string[]> => {
    const versionJsonUrl = await resolvePath(baseUrl, `/${appDir}/version.json`);

    try {
        const res = await makeRequest(versionJsonUrl, {});
        if (res && res.status === 200) {
            printMsg(MSG.Run, `[✓] Found SvelteKit version.json at ${versionJsonUrl}`);
            return [versionJsonUrl];
        }
    } catch {
        // Not found or unreachable — silently skip
    }

    return [];
};

export default svelte_getVersionJson;
