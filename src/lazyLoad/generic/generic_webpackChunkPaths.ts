import fs from "fs";
import path from "path";
import { extractWebpackChunkUrls } from "../shared/webpackChunkParsers.js";
import { extractFileSourceUrl } from "./generic_stringsDiscovery.js";
import { confirmJsContentType } from "./generic_scanAttributesForJs.js";

/**
 * Scans every JS file `generic` tech has already downloaded under outputDir for the
 * same webpack chunk-path-builder patterns the React crawler already resolves (see
 * `src/lazyLoad/shared/webpackChunkParsers.ts`). Internal#75: without this, a webpack
 * or module-federation entry chunk downloaded under `generic` tech only ever yields the
 * chunks that happened to fire live during the crawl — its own async-chunk hash-map is
 * never statically enumerated the way React's `react_webpackChunkPaths.ts` already does.
 *
 * Reads from disk (recovering each file's source URL via the same
 * `// File Source: <url>` header `generic_stringsDiscovery.ts` relies on) rather than
 * re-fetching over the network, since the file is already on disk from an earlier
 * download pass.
 */
const generic_webpackChunkPaths = async (
    outputDir: string,
    alreadyKnownUrls: Set<string> = new Set(),
    threads: number = 1
): Promise<string[]> => {
    if (!fs.existsSync(outputDir)) return [];

    const files = fs.readdirSync(outputDir, { recursive: true, encoding: "utf8" }) as string[];
    const jsFiles = files.filter((f) => f.endsWith(".js") || f.endsWith(".mjs"));

    const candidates = new Set<string>();
    for (const relPath of jsFiles) {
        const filePath = path.join(outputDir, relPath);
        let content: string;
        try {
            content = fs.readFileSync(filePath, "utf-8");
        } catch {
            continue;
        }

        const sourceUrl = extractFileSourceUrl(content);
        if (!sourceUrl) continue;

        for (const url of extractWebpackChunkUrls(content, sourceUrl)) {
            if (!alreadyKnownUrls.has(url)) candidates.add(url);
        }
    }

    if (candidates.size === 0) return [];
    return confirmJsContentType([...candidates], threads);
};

export default generic_webpackChunkPaths;
