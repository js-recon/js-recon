import fs from "fs";
import path from "path";
import strings from "../../strings/index.js";
import { resolveJsPathCandidate, confirmJsContentType } from "./generic_scanAttributesForJs.js";
import { printMsg, MSG } from "../../utility/printMsg.js";

/**
 * Parses the `// File Source: <url>` header every generic-downloaded file carries
 * as its first line (written by generic_downloadFiles.ts and generic_getScriptTags.ts)
 * to recover the URL a downloaded file actually came from. This is what lets string
 * literals found inside that file resolve against ITS OWN url — unlike Next.js's
 * subsequent-requests pass (next_SubsequentRequests.ts), which resolves every
 * extracted path against a single fixed target URL for the whole crawl.
 */
export const extractFileSourceUrl = (fileContent: string): string | null => {
    const match = /^\/\/ File Source: (\S+)/.exec(fileContent);
    return match ? match[1] : null;
};

/**
 * Pure candidate extraction: given the strings module's raw per-file output
 * ({ [filePath]: string[] }), resolves each string against the URL its own file
 * came from and keeps the ones that look like a JS path. readFile is injected so
 * this stays unit-testable without real filesystem access.
 */
export const findJsPathCandidatesFromStrings = (
    allStrings: Record<string, string[]>,
    readFile: (filePath: string) => string
): string[] => {
    const candidates = new Set<string>();

    for (const filePath of Object.keys(allStrings)) {
        let content: string;
        try {
            content = readFile(filePath);
        } catch {
            continue;
        }

        const sourceUrl = extractFileSourceUrl(content);
        if (!sourceUrl) continue;

        for (const str of allStrings[filePath] ?? []) {
            const resolved = resolveJsPathCandidate(str, sourceUrl);
            if (resolved) candidates.add(resolved);
        }
    }

    return [...candidates];
};

let stringsPassCounter = 0;

/**
 * Runs the existing `strings` module against the generic crawl's whole output
 * directory (files span multiple host subdirectories — the page's own host plus
 * any third-party asset hosts), recovers per-file source URLs, and confirms
 * JS-looking string-literal candidates via Content-Type. Internal#66: WordPress
 * plugin configs routinely reference further JS assets only as a string inside
 * an already-downloaded file (inline script or external JS), invisible to
 * attribute scanning or <script src> discovery.
 *
 * alreadyKnownUrls (typically the caller's running downloadedJsUrls set) is
 * filtered out BEFORE confirmJsContentType, not after — each subsequent pass
 * rescans the same growing directory (strings() has no incremental-scan mode),
 * so without this every already-confirmed URL from a prior pass would otherwise
 * trigger a redundant live GET request every single pass.
 */
const generic_stringsDiscovery = async (
    outputDir: string,
    alreadyKnownUrls: Set<string> = new Set()
): Promise<string[]> => {
    if (!fs.existsSync(outputDir)) return [];

    const tmpStringsFile = path.join(outputDir, `.generic-strings-pass-${stringsPassCounter++}.json`);

    try {
        await strings(outputDir, tmpStringsFile, false, "", false, false, false);
    } catch (err) {
        printMsg(MSG.Warn, `[!] Generic strings discovery pass failed: ${err}`);
        return [];
    }

    let allStrings: Record<string, string[]>;
    try {
        allStrings = JSON.parse(fs.readFileSync(tmpStringsFile, "utf-8"));
    } catch {
        return [];
    } finally {
        try {
            fs.unlinkSync(tmpStringsFile);
        } catch {
            /* best-effort cleanup — a leftover temp file isn't fatal */
        }
    }

    const candidates = findJsPathCandidatesFromStrings(allStrings, (p) => fs.readFileSync(p, "utf-8")).filter(
        (u) => !alreadyKnownUrls.has(u)
    );
    if (candidates.length === 0) return [];
    return confirmJsContentType(candidates);
};

export default generic_stringsDiscovery;
