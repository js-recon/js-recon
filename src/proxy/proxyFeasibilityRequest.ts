import { getWithMetadata } from "./genReq.js";
import { buildUndiciDispatcher, withManagedDispatcher } from "../utility/makeReq.js";
import type { ResolvedProxyConfig } from "./resolveProxyConfig.js";

export interface ProxyFeasibilityResponse {
    readonly body: string;
    readonly status?: number;
    readonly headers?: Record<string, string> | Headers;
}

/**
 * Makes a single request to `url` through the given resolved proxy method and returns the
 * response body, status, and headers. Shared by `checkFeasibility` across all four proxy
 * methods so the feasibility flow doesn't special-case AWS vs undici-dispatched methods itself.
 *
 * @param resolved - The resolved proxy config to route the request through.
 * @param url - The target URL to request.
 * @returns The response body, status, and headers.
 */
export const proxyFeasibilityRequest = async (
    resolved: ResolvedProxyConfig,
    url: string
): Promise<ProxyFeasibilityResponse> => {
    if (resolved.method === "aws") {
        return await getWithMetadata(url);
    }
    const dispatcher = buildUndiciDispatcher(resolved);
    return await withManagedDispatcher(dispatcher, async (options) => {
        const response = await fetch(url, options);
        const body = await response.text();
        return { body, status: response.status, headers: response.headers };
    });
};
