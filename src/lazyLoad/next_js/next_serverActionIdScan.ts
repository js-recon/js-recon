import fs from "fs";
import path from "path";

/**
 * Matches `createServerReference("<id>", ...)` (and its minified sequence-expression form,
 * `(0, X.createServerReference)("<id>", ...)`) directly in raw chunk text. The property name
 * `createServerReference` itself survives minification (it's accessed off the
 * react-server-dom-webpack runtime import, not a local declaration a minifier would rename),
 * which is also why `map/next_js/resolveServerActions.ts` pre-filters chunks with a substring
 * check on the same string before running its AST-based resolution.
 */
const ACTION_ID_CALL_PATTERN = /createServerReference\s*\)?\s*\(\s*["'`]([0-9a-f]{40,})["'`]/gi;

/**
 * Extracts Server Action IDs referenced via `createServerReference(...)` in a chunk's raw
 * text. Mirrors the ID-format validation in `map/next_js/resolveServerActions.ts`
 * (`/^[0-9a-f]{40,}$/i`), but works on unparsed text rather than a Babel AST — a lightweight
 * signal available at `lazyload` time, before `map`'s full AST-based resolution runs.
 */
export const extractServerActionIds = (chunkContent: string): string[] => {
    const ids = [...chunkContent.matchAll(ACTION_ID_CALL_PATTERN)].map((m) => m[1].toLowerCase());
    return [...new Set(ids)];
};

const walkJsFiles = (dir: string): string[] => {
    if (!fs.existsSync(dir)) return [];
    const results: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            results.push(...walkJsFiles(fullPath));
        } else if (entry.isFile() && fullPath.endsWith(".js")) {
            results.push(fullPath);
        }
    }
    return results;
};

export interface ServerActionIdScanResult {
    /** Server Action ID(s) found, keyed by the chunk file path they appeared in (relative to the scanned directory). */
    actionIdsByFile: Record<string, string[]>;
    /** Every distinct Server Action ID discovered across all scanned chunks. */
    allActionIds: string[];
}

/**
 * Walks every downloaded `.js` chunk under `scanDir` and records any Server Action ID
 * referenced in it. This is endpoint enumeration (attack-surface disclosure) only — no
 * action is invoked. A discovered ID is worth cross-referencing against which pages the
 * crawl could actually reach unauthenticated: an ID present in a chunk for a page the crawl
 * never reached without a session is itself a disclosure signal (see
 * js-recon-internal-docs#157 / CVE-2026-64643 for the historical case this generalizes).
 */
const next_serverActionIdScan = async (scanDir: string): Promise<ServerActionIdScanResult> => {
    const actionIdsByFile: Record<string, string[]> = {};
    const allActionIds = new Set<string>();

    for (const filePath of walkJsFiles(scanDir)) {
        let content: string;
        try {
            content = fs.readFileSync(filePath, "utf-8");
        } catch {
            continue;
        }
        if (!content.includes("createServerReference")) continue;

        const ids = extractServerActionIds(content);
        if (ids.length === 0) continue;

        actionIdsByFile[path.relative(scanDir, filePath)] = ids;
        for (const id of ids) allActionIds.add(id);
    }

    return { actionIdsByFile, allActionIds: [...allActionIds] };
};

export default next_serverActionIdScan;
