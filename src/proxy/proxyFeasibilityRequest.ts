import { get } from "./genReq.js";
import { buildUndiciDispatcher, type FetchOptsWithDispatcher } from "../utility/makeReq.js";
import type { ResolvedProxyConfig } from "./resolveProxyConfig.js";

/**
 * Makes a single request to `url` through the given resolved proxy method and returns the
 * response body as text. Shared by `checkFeasibility` across all four proxy methods so the
 * feasibility flow doesn't special-case AWS vs undici-dispatched methods itself.
 *
 * @param resolved - The resolved proxy config to route the request through.
 * @param url - The target URL to request.
 * @returns The response body text.
 */
export const proxyFeasibilityRequest = async (resolved: ResolvedProxyConfig, url: string): Promise<string> => {
    if (resolved.method === "aws") {
        return await get(url);
    }
    const dispatcher = buildUndiciDispatcher(resolved);
    const opts: FetchOptsWithDispatcher = dispatcher ? { dispatcher } : {};
    const res = await fetch(url, opts);
    return await res.text();
};
