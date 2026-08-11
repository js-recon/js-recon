// Bundler detection for the `run` pipeline using CS-MAST-S signatures.
// Determines which bundler (webpack, vite, etc.) was used to build a target's
// JS bundle by sampling collision signatures from the HuggingFace bucket and
// counting how many appear in the bundle's own CS-MAST signature set.

import fs from "fs";
import { ScatCategory } from "@shriyanss/cs-mast";
import {
    TECH_TO_BRANCH,
    validateRemoteBranch,
    listCollisionsFiles,
    listCollisionsFileHashes,
    fetchCollisionsJson,
    getHfRawUrl,
} from "../refactor/remote/hf-client.js";
import {
    isSignatureCacheFresh,
    loadCachedSignature,
    saveSignatureToCache,
    loadListCache,
    saveListCache,
    shouldRefreshListCache,
} from "../refactor/remote/cache.js";
import { loadRefactorConfig } from "../refactor/remote/config.js";
import { generateBundleSignatures } from "../refactor/remote/version-detect.js";
import { Chunks } from "../utility/interfaces.js";
import { printMsg, MSG } from "../utility/printMsg.js";

// Maps run-module framework names to candidate refactor tech identifiers.
const FRAMEWORK_TO_TECHS: Record<string, string[]> = {
    react: ["react-webpack", "react-vite"],
    vue: ["vue-webpack", "vue-vite"],
    nuxt: ["vue-webpack", "vue-vite"],
    next: ["next-webpack", "next-turbopack"],
};

const DETECTION_SCAT: ScatCategory[] = ["lit", "decl", "loop", "cond"];
const DETECTION_SCAT_DIR = "lit-decl-loop-cond";
// Current react-webpack/react-vite buckets hold ~36 collision files each for this scat.
// Sampling only 15 of them left match counts sensitive to which random subset was drawn —
// close calls (e.g. two candidates within a few percent of each other) could flip which
// tech "won" between identical runs against the same bundle. Set high enough to cover the
// full bucket at its current size; `randomSample` still caps it if the bucket grows well
// past this.
const DETECTION_SAMPLE_SIZE = 200;

// Literal bundler-runtime markers, checked before the CS-MAST-S structural comparison.
// Module-loader glue and preload polyfills are emitted verbatim by the bundler itself —
// unlike app/library code, minifiers don't rename these literal property/string
// accesses, so they're a cheap, high-confidence signal when exactly one candidate's
// markers are present. CS-MAST-S structural signatures can't discriminate reliably here:
// they're computed over app + vendored library code, which is largely bundler-agnostic,
// so two candidates can score closely even when only one bundler's runtime is actually
// present in the bundle.
const BUNDLER_MARKERS: Record<string, RegExp[]> = {
    "react-webpack": [/__webpack_require__/, /__webpack_modules__/, /webpackJsonp/],
    "react-vite": [/\.supports\(\s*["']modulepreload["']\s*\)/, /__vite__mapDeps/, /__vitePreload/],
};

/**
 * Checks bundle code for literal bundler-runtime markers unique to each candidate tech.
 * Returns the matching tech only when exactly one candidate's markers are present —
 * ambiguous (multiple or zero matches) cases are left to the CS-MAST-S comparison.
 */
export function detectByMarker(chunks: Chunks, candidateTechs: string[]): string | null {
    const allCode = Object.values(chunks)
        .map((c) => c.code)
        .filter(Boolean)
        .join("\n");
    const matched = candidateTechs.filter((tech) => (BUNDLER_MARKERS[tech] ?? []).some((re) => re.test(allCode)));
    return matched.length === 1 ? matched[0] : null;
}

function randomSample<T>(arr: T[], n: number): T[] {
    const copy = [...arr];
    const result: T[] = [];
    const count = Math.min(n, copy.length);
    for (let i = 0; i < count; i++) {
        const j = Math.floor(Math.random() * (copy.length - i)) + i;
        [copy[i], copy[j]] = [copy[j], copy[i]];
        result.push(copy[i]);
    }
    return result;
}

/**
 * Detects the bundler used by a target's JS bundle using CS-MAST-S signatures.
 *
 * Samples collision signatures from the HuggingFace bucket for each candidate
 * tech and counts how many appear in the bundle's signature set. Returns the
 * tech identifier (e.g. "react-webpack") with the most matches if the count
 * meets the threshold, or null if detection fails or is below threshold.
 *
 * @param mappedJsonPath - Path to the mapped.json produced by the map step
 * @param framework - Framework name as detected by lazyload (e.g. "react", "vue")
 * @param threshold - Minimum match count required to consider a tech detected
 * @param skipCacheChecks - When true, treat all caches as fresh (skip TTL checks)
 */
export async function detectBundler(
    mappedJsonPath: string,
    framework: string,
    threshold: number,
    skipCacheChecks = false
): Promise<string | null> {
    const candidateTechs = FRAMEWORK_TO_TECHS[framework];
    if (!candidateTechs) return null;

    // Only consider techs that have a bucket branch; others are not yet supported.
    const availableTechs = candidateTechs.filter((t) => TECH_TO_BRANCH[t]);
    if (availableTechs.length === 0) return null;

    // Load mapped.json and generate bundle signatures once (reused for all candidates).
    let chunks: Chunks;
    try {
        chunks = JSON.parse(fs.readFileSync(mappedJsonPath, "utf8")) as Chunks;
    } catch {
        printMsg(MSG.Warn, "[!] Bundler detection: could not read mapped.json — skipping refactor.");
        return null;
    }

    const markerTech = detectByMarker(chunks, availableTechs);
    if (markerTech) {
        printMsg(
            MSG.Header,
            `[i] Bundler detection: ${markerTech} — matched via bundler runtime marker (skipping CS-MAST-S sampling)`
        );
        return markerTech;
    }

    const bundleSigs = generateBundleSignatures(chunks, DETECTION_SCAT);
    if (bundleSigs.size === 0) {
        printMsg(MSG.Warn, "[!] Bundler detection: bundle produced no CS-MAST signatures — skipping refactor.");
        return null;
    }

    const config = await loadRefactorConfig();
    let bestTech: string | null = null;
    let bestMatchCount = 0;

    for (const tech of availableTechs) {
        const branch = TECH_TO_BRANCH[tech];

        // Validate the HF bucket branch exists.
        const branchOk = await validateRemoteBranch(branch);
        if (!branchOk) {
            printMsg(MSG.Warn, `[!] Bundler detection: no signatures for ${tech} in remote bucket — skipping.`);
            continue;
        }

        // Resolve the list of collision files, using the list cache when fresh.
        let listCache = loadListCache();
        const branchMissingFromCache = !listCache?.branches[branch];
        if (shouldRefreshListCache(listCache, { refreshCache: false, skipCacheChecks }) || branchMissingFromCache) {
            printMsg(MSG.Header, `[i] Refreshing file list cache for ${branch}...`);
            const paths = await listCollisionsFiles(branch, DETECTION_SCAT_DIR);
            const now = Date.now();
            const branches: Record<string, string[]> = listCache?.branches ?? {};
            branches[branch] = paths;
            listCache = { generatedAt: now, branches };
            saveListCache(listCache);
        }

        const allPaths = (listCache?.branches[branch] ?? []).filter((p) =>
            p.endsWith(`/${DETECTION_SCAT_DIR}/collisions.json`)
        );

        if (allPaths.length === 0) {
            printMsg(
                MSG.Warn,
                `[!] Bundler detection: no collision files for scat "${DETECTION_SCAT_DIR}" in branch "${branch}" — skipping.`
            );
            continue;
        }

        // Sample a random subset to keep detection fast.
        const sampled = randomSample(allPaths, DETECTION_SAMPLE_SIZE);

        // Content-based cache validation: same mechanism as the refactor module — one
        // per-branch tree fetch to detect upstream dataset changes within the age-based TTL.
        // A failure here (e.g. HF rate-limiting) must never abort bundler detection — fall
        // back to an empty map, which degrades cache-freshness checks to the age-based TTL.
        let remoteHashes = new Map<string, string>();
        if (!skipCacheChecks) {
            try {
                remoteHashes = await listCollisionsFileHashes(branch, DETECTION_SCAT_DIR);
            } catch (e) {
                printMsg(
                    MSG.Warn,
                    `[!] Could not fetch upstream content hashes for cache validation (${(e as Error).message}) — falling back to age-based cache checks.`
                );
            }
        }

        let matchCount = 0;
        for (const subpath of sampled) {
            let records;
            const remoteHash = remoteHashes.get(subpath) ?? null;
            if (isSignatureCacheFresh(branch, subpath, skipCacheChecks, remoteHash)) {
                records = loadCachedSignature(branch, subpath);
            } else {
                records = await fetchCollisionsJson(getHfRawUrl(branch, subpath));
                if (records) {
                    saveSignatureToCache(branch, subpath, records, config.maxCacheSizeMb, remoteHash);
                }
            }
            if (!records) continue;

            for (const record of records) {
                if (bundleSigs.has(record.signature)) {
                    matchCount++;
                }
            }
        }

        printMsg(
            MSG.Header,
            `[i] Bundler detection: ${tech} — ${matchCount} signature match(es) (threshold: ${threshold})`
        );

        if (matchCount > bestMatchCount) {
            bestMatchCount = matchCount;
            bestTech = tech;
        }
    }

    if (bestTech !== null && bestMatchCount >= threshold) {
        return bestTech;
    }
    return null;
}
