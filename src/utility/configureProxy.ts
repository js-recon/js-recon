import fs from "fs";
import chalk from "chalk";
import * as globalsUtil from "./globals.js";
import { resolveProxyConfig, type ResolvedProxyConfig } from "../proxy/resolveProxyConfig.js";
import { parseProxyUrl } from "../proxy/genericProxy.js";
import { composeOxylabsUsername, resolveOxylabsEndpoint } from "../proxy/oxylabsProxy.js";

/**
 * Reads the proxy config file (if present) and resolves env (unless --ignore-proxy-env) > file
 * precedence via resolveProxyConfig, then sets the resulting proxy-related globals.
 *
 * `lazyload`/`run` only ever pass a config file reference (`--proxy-config`) — all method
 * selection and credentials live in `.proxy_config.json`, generated interactively via the
 * `proxy` module's `-i/--init` wizard. There is no per-run CLI override for credentials here.
 * @param cmd - The commander command object.
 */
const configureProxy = (cmd): void => {
    const configFile = cmd.proxyConfig || ".proxy_config.json";

    let configFileParsed = {};
    if (fs.existsSync(configFile)) {
        try {
            configFileParsed = JSON.parse(fs.readFileSync(configFile, "utf8"));
        } catch (err) {
            console.error(
                chalk.yellow(
                    `[!] Failed to parse proxy config file ${configFile}: ${err.message}. Proceeding with no proxy.`
                )
            );
            configFileParsed = {};
        }
    }

    let resolved: ResolvedProxyConfig;
    try {
        resolved = resolveProxyConfig({
            cli: {},
            env: process.env,
            ignoreEnv: cmd.ignoreProxyEnv === true,
            configFileParsed,
        });
    } catch (err) {
        console.error(chalk.red(`[!] Invalid Oxylabs config: ${err.message}`));
        process.exit(1);
    }

    if ((resolved.method === "socks" || resolved.method === "http") && resolved.url) {
        try {
            parseProxyUrl(resolved.url);
        } catch (err) {
            console.error(chalk.red(`[!] Invalid proxy URL: ${err.message}`));
            process.exit(1);
        }
    }

    if (resolved.method === "oxylabs" && resolved.oxylabs) {
        try {
            composeOxylabsUsername(resolved.oxylabs);
            resolveOxylabsEndpoint(resolved.oxylabs.endpoint);
        } catch (err) {
            console.error(chalk.red(`[!] Invalid Oxylabs config: ${err.message}`));
            process.exit(1);
        }
    }

    globalsUtil.setProxyConfigFile(configFile);
    globalsUtil.setIgnoreProxyEnv(cmd.ignoreProxyEnv === true);
    globalsUtil.setProxyMethod(resolved.method);
    globalsUtil.setUseProxy(resolved.method !== null);
    globalsUtil.setProxyUrl(resolved.url);
    globalsUtil.setOxylabsConfig(resolved.oxylabs);
};

export default configureProxy;
