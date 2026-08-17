import { printMsg, MSG } from "../../utility/printMsg.js";
import * as globals from "../globals.js";
import makeRequest from "../../utility/makeReq.js";
import * as parser from "@babel/parser";
import traverse from "@babel/traverse";
/**
 * Pure parser: given the text content of a `_buildManifest.js` file and the URL
 * it was fetched from, returns absolute URLs for every `static/chunks/` entry.
 */
export const parseChunksFromBuildManifest = (content: string, buildManifestUrl: string): string[] => {
    const result: string[] = [];
    try {
        const ast = parser.parse(content, {
            sourceType: "unambiguous",
            plugins: ["jsx", "typescript"],
            errorRecovery: true,
        });

        const strings: string[] = [];
        traverse(ast, {
            StringLiteral(path) {
                strings.push(path.node.value);
            },
        });

        for (const s of strings) {
            if (s.includes("static/chunks/")) {
                result.push(new URL(`../../${s}`, buildManifestUrl).href);
            }
        }
    } catch {
        // malformed content — return empty
    }
    return result;
};

/**
 * Finds lazy-loaded JavaScript files from Next.js `_buildManifest.js`.
 */
const next_getLazyResourcesBuildManifestJs = async (url: string): Promise<string[] | any> => {
    const foundUrls = globals.getJsUrls();
    const toReturn: string[] = [];

    let buildManifestUrl: string = "";
    for (const jsUrl of foundUrls) {
        if (jsUrl.endsWith("_buildManifest.js")) {
            buildManifestUrl = jsUrl;
            break;
        }
    }

    if (buildManifestUrl === "") {
        return [];
    }

    try {
        const response = await makeRequest(buildManifestUrl, {});
        if (!response) return [];

        const buildManifestContent = await response.text();
        const chunks = parseChunksFromBuildManifest(buildManifestContent, buildManifestUrl);

        for (const foundUrl of chunks) {
            globals.pushToJsUrls(foundUrl);
            toReturn.push(foundUrl);
        }

        if (toReturn.length > 0) {
            printMsg(MSG.Run, `[✓] Found ${toReturn.length} JS files from _buildManifest.js`);
        }
    } catch (err: any) {
        if (err?.code !== "ENOENT") {
            printMsg(MSG.Err, `[!] Failed to parse _buildManifest.js: ${err?.message ?? err}`);
        }
    }

    return toReturn;
};

export default next_getLazyResourcesBuildManifestJs;
