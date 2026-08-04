import fs from "fs";
import path from "path";
import { confirmJsContentType } from "./generic_scanAttributesForJs.js";

/**
 * Parses a downloaded file's content for a Webpack Module Federation "import map"
 * manifest shape:
 *   { "microFrontends": { "<scope>/<name>": [{ "url": "https://.../remote-entry.js", ... }] } }
 * and returns every remote-entry-style URL it lists. Tolerates the
 * `// File Source: <url>\n` header `generic_downloadFiles.ts` prefixes onto every
 * downloaded file — these manifests are typically referenced via a literal
 * `<script src="...prod.json">` tag (picked up like any other script by
 * `generic_getScriptTags.ts` regardless of extension) and saved under a synthesized
 * `.js` filename despite being JSON (see `generic_downloadFiles.ts::synthesizeFilename`),
 * so the header must be stripped before `JSON.parse`.
 */
export const extractMicroFrontendUrls = (content: string): string[] => {
    const withoutHeader = content.replace(/^\/\/ File Source: \S+\n/, "");

    let data: unknown;
    try {
        data = JSON.parse(withoutHeader);
    } catch {
        return [];
    }

    if (typeof data !== "object" || data === null || !("microFrontends" in data)) return [];
    const microFrontends = (data as Record<string, unknown>).microFrontends;
    if (typeof microFrontends !== "object" || microFrontends === null) return [];

    const urls = new Set<string>();
    for (const entries of Object.values(microFrontends as Record<string, unknown>)) {
        if (!Array.isArray(entries)) continue;
        for (const entry of entries) {
            const url = (entry as Record<string, unknown> | null)?.url;
            if (typeof url === "string" && /^https?:\/\//i.test(url) && url.toLowerCase().endsWith(".js")) {
                urls.add(url);
            }
        }
    }
    return [...urls];
};

/**
 * Scans every file `generic` tech has already downloaded under outputDir for a
 * micro-frontend import-map manifest (see `extractMicroFrontendUrls`) and confirms each
 * referenced remote-entry URL via Content-Type before returning it as a new download
 * candidate. Internal#74: js-recon was already downloading these manifests (picked up
 * like any other `<script src>`) but never reading them — every remote a
 * module-federation app can dynamically load is listed here, including remotes whose
 * components never rendered (and so never fired a request) during the crawl.
 */
const generic_importMapDiscovery = async (
    outputDir: string,
    alreadyKnownUrls: Set<string> = new Set(),
    threads: number = 1
): Promise<string[]> => {
    if (!fs.existsSync(outputDir)) return [];

    const files = fs.readdirSync(outputDir, { recursive: true, encoding: "utf8" }) as string[];
    const candidates = new Set<string>();

    for (const relPath of files) {
        if (!/\.(js|mjs|json)$/i.test(relPath)) continue;
        const filePath = path.join(outputDir, relPath);
        let content: string;
        try {
            content = fs.readFileSync(filePath, "utf-8");
        } catch {
            continue;
        }
        for (const url of extractMicroFrontendUrls(content)) {
            if (!alreadyKnownUrls.has(url)) candidates.add(url);
        }
    }

    if (candidates.size === 0) return [];
    return confirmJsContentType([...candidates], threads);
};

export default generic_importMapDiscovery;
