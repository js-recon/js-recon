import { proxyUrlMethod, type ProxyUrlMethodOptions } from "./urlMethod.js";

export type ProxyHttpOptions = ProxyUrlMethodOptions;

/**
 * Entry point for `proxy http`: writes a generic HTTP proxy config to `.proxy_config.json`.
 *
 * @async
 * @param opts - Resolved CLI options for the `proxy http` subcommand.
 * @returns {Promise<void>}
 */
const proxyHttp = async (opts: ProxyHttpOptions): Promise<void> => proxyUrlMethod("http", opts);

export default proxyHttp;
