/**
 * Source Map Decoder
 *
 * Extracts original source code from minified JavaScript using source maps.
 */

import fs from "fs";
import path from "path";
import chalk from "chalk";
import makeRequest from "../utility/makeReq.js";
import { runWithConcurrency } from "../utility/concurrency.js";
import { progressLog } from "../utility/progressLog.js";
import { getSanitizedAssetFilename, resolveAssetOutputDirectory } from "./outputPath.js";

/**
 * Source map JSON structure (v3)
 */
export interface SourceMap {
    version: number;
    file?: string;
    sourceRoot?: string;
    sources: string[];
    sourcesContent?: (string | null)[];
    names?: string[];
    mappings: string;
}

/**
 * Extracted source file
 */
export interface SourceFile {
    /** Original file path from the source map */
    path: string;
    /** Original source code content */
    content: string;
}

/**
 * Result of extracting sources from a source map
 */
export interface ExtractResult {
    /** Array of extracted source files */
    files: SourceFile[];
    /** Number of sources that had no content (sourcesContent was null) */
    missingCount: number;
}

/**
 * Options for extracting source files
 */
export interface ExtractOptions {
    /** Remove webpack:// and similar protocol prefixes from paths (default: true) */
    cleanPaths?: boolean;
    /** Normalize ../ sequences in paths (default: true) */
    normalizePaths?: boolean;
}

/**
 * Extract original source files from a source map.
 *
 * @param sourceMap - The source map object or JSON string
 * @param options - Optional configuration
 * @returns Object containing extracted files and count of missing sources
 *
 * @example
 * ```typescript
 * import { extractSources } from './sourcemap';
 *
 * const sourceMap = {
 *   version: 3,
 *   sources: ['src/app.ts', 'src/utils.ts'],
 *   sourcesContent: ['const x = 1;', 'export const y = 2;'],
 *   mappings: '...',
 * };
 *
 * const result = extractSources(sourceMap);
 * for (const file of result.files) {
 *   console.log(`${file.path}:\n${file.content}`);
 * }
 * ```
 */
export function extractSources(sourceMap: SourceMap | string, options: ExtractOptions = {}): ExtractResult {
    const { cleanPaths = true, normalizePaths = true } = options;

    // Parse JSON string if needed
    const map: SourceMap = typeof sourceMap === "string" ? JSON.parse(sourceMap) : sourceMap;

    // Validate source map
    if (!map.sources || !Array.isArray(map.sources)) {
        throw new Error('Invalid source map: missing "sources" array');
    }

    const files: SourceFile[] = [];
    let missingCount = 0;

    for (let i = 0; i < map.sources.length; i++) {
        let path = map.sources[i];
        const content = map.sourcesContent?.[i];

        // Skip if no content
        if (content === null || content === undefined) {
            missingCount++;
            continue;
        }

        // Clean up path
        if (cleanPaths) {
            path = cleanPath(path);
        }
        if (normalizePaths) {
            path = normalizePath(path);
        }

        // Apply sourceRoot if present
        if (map.sourceRoot && !path.startsWith("/")) {
            const root = cleanPaths ? cleanPath(map.sourceRoot) : map.sourceRoot;
            path = joinPaths(root, path);
        }

        files.push({ path, content });
    }

    return { files, missingCount };
}

/**
 * Extract a single source file by index or path.
 *
 * @param sourceMap - The source map object or JSON string
 * @param indexOrPath - Index into sources array or file path to find
 * @returns The source file or null if not found
 */
export function extractSource(sourceMap: SourceMap | string, indexOrPath: number | string): SourceFile | null {
    const map: SourceMap = typeof sourceMap === "string" ? JSON.parse(sourceMap) : sourceMap;

    if (typeof indexOrPath === "number") {
        const index = indexOrPath;
        if (index < 0 || index >= map.sources.length) {
            return null;
        }
        const content = map.sourcesContent?.[index];
        if (content === null || content === undefined) {
            return null;
        }
        return { path: map.sources[index], content };
    }

    // Search by path
    const searchPath = indexOrPath;
    const index = map.sources.findIndex(
        (s) =>
            s === searchPath ||
            s.endsWith(searchPath) ||
            cleanPath(s) === searchPath ||
            cleanPath(s).endsWith(searchPath)
    );

    if (index === -1) {
        return null;
    }

    const content = map.sourcesContent?.[index];
    if (content === null || content === undefined) {
        return null;
    }

    return { path: map.sources[index], content };
}

/**
 * Get list of source file paths without extracting content.
 *
 * @param sourceMap - The source map object or JSON string
 * @returns Array of source file paths
 */
export function listSources(sourceMap: SourceMap | string): string[] {
    const map: SourceMap = typeof sourceMap === "string" ? JSON.parse(sourceMap) : sourceMap;

    return map.sources || [];
}

/**
 * Check if a source map has embedded source content.
 *
 * @param sourceMap - The source map object or JSON string
 * @returns true if sourcesContent is present and has at least one non-null entry
 */
export function hasSourceContent(sourceMap: SourceMap | string): boolean {
    const map: SourceMap = typeof sourceMap === "string" ? JSON.parse(sourceMap) : sourceMap;

    return Array.isArray(map.sourcesContent) && map.sourcesContent.some((c) => c !== null && c !== undefined);
}

/**
 * Remove protocol prefixes like webpack://, file://, etc.
 */
function cleanPath(path: string): string {
    return path
        .replace(/^webpack:\/\/[^/]*\//, "") // webpack://package-name/
        .replace(/^webpack:\/\//, "") // webpack://
        .replace(/^file:\/\//, "") // file://
        .replace(/^\.\//, ""); // ./
}

/**
 * Normalize path by resolving ../ sequences.
 * SECURITY: Removes all leading ../ to prevent directory traversal attacks.
 * Files will always stay within the intended output directory.
 */
function normalizePath(path: string): string {
    const parts = path.split("/");
    const result: string[] = [];

    for (const part of parts) {
        if (part === "..") {
            // Only allow going back within the path we've built
            // Never allow escaping (result would go negative)
            if (result.length > 0) {
                result.pop();
            }
            // If result is empty, just skip the '..' entirely (prevents traversal)
        } else if (part !== "." && part !== "") {
            result.push(part);
        }
    }

    return result.join("/") || ".";
}

/**
 * Join two path segments
 */
function joinPaths(base: string, path: string): string {
    if (!base) return path;
    if (!path) return base;

    const baseClean = base.endsWith("/") ? base.slice(0, -1) : base;
    const pathClean = path.startsWith("/") ? path.slice(1) : path;

    return `${baseClean}/${pathClean}`;
}

/**
 * Decode an inline `data:` URI sourceMappingURL reference into raw source-map JSON text.
 *
 * Handles both base64-encoded (`data:application/json;base64,<...>`, with or without a
 * `charset` parameter) and percent-encoded (`data:application/json,<...>`) payloads.
 * Verifies the decoded content actually looks like a source map (has a `sources` array)
 * before returning it, so an unrelated `data:` URI that happens to be valid JSON doesn't
 * get treated as a sourcemap.
 *
 * @param rawRef - The raw string following `sourceMappingURL=`
 * @returns The decoded JSON text, or null if `rawRef` isn't a decodable inline source map
 */
export function decodeInlineSourceMapDataUri(rawRef: string): string | null {
    if (!rawRef.startsWith("data:")) return null;

    const commaIndex = rawRef.indexOf(",");
    if (commaIndex === -1) return null;

    const meta = rawRef.slice(5, commaIndex);
    const payload = rawRef.slice(commaIndex + 1);
    const isBase64 = meta.split(";").includes("base64");

    try {
        const decoded = isBase64 ? Buffer.from(payload, "base64").toString("utf-8") : decodeURIComponent(payload);
        const parsed = JSON.parse(decoded);
        if (typeof parsed !== "object" || parsed === null || !Array.isArray(parsed.sources)) return null;
        return decoded;
    } catch {
        return null;
    }
}

/**
 * Write a decoded inline source map to disk at the same location a real downloaded
 * `.map` file for this JS URL would land at, so the existing `extractSourceMaps` disk
 * scan (which matches by `.map` extension, not by naming convention) picks it up.
 *
 * Best-effort: swallows all errors, per this directory's "sourcemap fetch is best-effort"
 * convention. Never throws.
 */
export function writeInlineSourceMap(output: string, jsUrl: string, mapContent: string): void {
    try {
        const filename = getSanitizedAssetFilename(jsUrl);
        if (!filename) return;
        const dir = resolveAssetOutputDirectory(output, jsUrl);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `${filename}.map`), mapContent);
    } catch {
        // best-effort; never fatal
    }
}

/**
 * Discover sourcemaps referenced by a list of JS files.
 *
 * For each file, fetches its content and looks for a `//# sourceMappingURL=...` comment.
 * Inline `data:` URI references are decoded and written directly to `output` (no HTTP
 * fetch needed). Real relative/absolute references are resolved to absolute URLs and
 * returned so the caller can enqueue them for download, same as before.
 *
 * @param jsFiles - JS file URLs to scan
 * @param threads - concurrency for the fetch loop
 * @param output - output directory inline maps are written under
 * @returns Absolute URLs of real (non-inline) sourcemaps found
 */
export async function discoverSourcemapUrls(
    jsFiles: string[],
    threads: number = 1,
    output: string = ""
): Promise<string[]> {
    const mapUrls: string[] = [];
    let inlineCount = 0;

    await runWithConcurrency(jsFiles, threads, async (jsUrl) => {
        try {
            const res = await makeRequest(jsUrl, { reportErrors: false });
            if (!res) return;
            const body = await res.text();
            const match = body.match(/\/\/# sourceMappingURL=(.+)$/m);
            if (!match) return;

            const rawRef = match[1].trim();
            if (rawRef.startsWith("data:")) {
                const decoded = decodeInlineSourceMapDataUri(rawRef);
                if (decoded) {
                    writeInlineSourceMap(output, jsUrl, decoded);
                    inlineCount++;
                }
                return;
            }

            const mapUrl: string = new URL(rawRef, jsUrl).href;
            mapUrls.push(mapUrl);
        } catch (_) {
            // skip files that fail to fetch
        }
    });

    if (mapUrls.length > 0) {
        progressLog(chalk.green(`[✓] Found ${mapUrls.length} sourcemaps from ${jsFiles.length} JS files`));
    }
    if (inlineCount > 0) {
        progressLog(chalk.green(`[✓] Decoded ${inlineCount} inline (base64) sourcemap(s)`));
    }

    return mapUrls;
}

// Default export for convenience
export default { extractSources, extractSource, listSources, hasSourceContent };
