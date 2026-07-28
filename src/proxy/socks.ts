import { proxyUrlMethod, type ProxyUrlMethodOptions } from "./urlMethod.js";

export type ProxySocksOptions = ProxyUrlMethodOptions;

/**
 * Entry point for `proxy socks`: writes a generic SOCKS5 proxy config to `.proxy_config.json`.
 *
 * @async
 * @param opts - Resolved CLI options for the `proxy socks` subcommand.
 * @returns {Promise<void>}
 */
const proxySocks = async (opts: ProxySocksOptions): Promise<void> => proxyUrlMethod("socks", opts);

export default proxySocks;
