import { printMsg, MSG } from "../../utility/printMsg.js";
import { customHeadersToRecord } from "../../utility/customHeaders.js";
import * as globals from "../../utility/globals.js";

/**
 * Extracts the host (scheme-independent, matches the format used throughout
 * `lazyLoad/globals.ts`'s scope list) from a URL.
 */
export const hostFromUrl = (url: string): string => new URL(url).host;

/**
 * Manually follows HTTP redirects starting at startUrl, up to maxRedirects hops,
 * and returns the final URL reached. Uses redirect: "manual" (rather than the
 * platform default of automatically following) so the hop count is actually
 * enforced by this function instead of an opaque undici-internal limit.
 */
export const resolveRedirectChain = async (
    startUrl: string,
    maxRedirects: number,
    fetchImpl: typeof fetch = fetch
): Promise<string> => {
    let currentUrl = startUrl;

    for (let i = 0; i < maxRedirects; i++) {
        let res: Response;
        try {
            res = await fetchImpl(currentUrl, {
                redirect: "manual",
                headers: {
                    ...customHeadersToRecord(globals.getCustomHeaders()),
                    ...globals.getPrivateHeadersForUrl(currentUrl),
                },
            });
        } catch {
            return currentUrl;
        }

        if (res.status >= 300 && res.status < 400) {
            const location = res.headers.get("location");
            if (!location) return currentUrl;
            try {
                currentUrl = new URL(location, currentUrl).href;
            } catch {
                return currentUrl;
            }
            continue;
        }

        return currentUrl;
    }

    return currentUrl;
};

/**
 * Default scope for the `generic` tech: fetch the target URL, follow redirects
 * (capped at maxRedirects), and scope the crawl to the host of the final
 * destination. Without this, an unscoped generic crawl would follow every
 * in-page link across the entire web.
 */
const resolveGenericScope = async (url: string, maxRedirects: number): Promise<string[]> => {
    const finalUrl = await resolveRedirectChain(url, maxRedirects);
    const host = hostFromUrl(finalUrl);
    printMsg(MSG.Header, `[i] Generic crawl scope resolved to: ${host}`);
    return [host];
};

export default resolveGenericScope;
