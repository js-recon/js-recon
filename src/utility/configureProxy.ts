import fs from "fs";
import { printMsg, MSG } from "./printMsg.js";
import * as globalsUtil from "./globals.js";
import { resolveProxyConfig } from "../proxy/resolveProxyConfig.js";
import { parseProxyUrl } from "../proxy/genericProxy.js";
import { composeOxylabsUsername } from "../proxy/oxylabsProxy.js";

/**
 * Reads the proxy config file (if present) and resolves env (unless --ignore-proxy-env) > file
 * precedence via resolveProxyConfig, then sets the resulting proxy-related globals.
 *
 * `lazyload`/`run` only ever pass a config file reference (`--proxy-config`) — all method
 * selection and credentials live in `.proxy_config.json`, generated interactively via the
 * `proxy aws`/`proxy oxylabs`/`proxy socks`/`proxy http` subcommands' `-i/--init` wizards. There
 * is no per-run CLI override for credentials here.
 * @param cmd - The commander command object.
 */
const configureProxy = (cmd): void => {
    const configFile = cmd.proxyConfig || ".proxy_config.json";

    let configFileParsed = {};
    if (fs.existsSync(configFile)) {
        try {
            configFileParsed = JSON.parse(fs.readFileSync(configFile, "utf8"));
        } catch (err) {
            printMsg(
                MSG.Warn,
                `[!] Failed to parse proxy config file ${configFile}: ${err.message}. Proceeding with no proxy.`
            );
            configFileParsed = {};
        }
    }

    const resolved = resolveProxyConfig({
        cli: {},
        env: process.env,
        ignoreEnv: cmd.ignoreProxyEnv === true,
        configFileParsed,
    });

    if ((resolved.method === "socks" || resolved.method === "http") && resolved.url) {
        try {
            parseProxyUrl(resolved.url);
        } catch (err) {
            printMsg(MSG.Err, `[!] Invalid proxy URL: ${err.message}`);
            process.exit(1);
        }
    }

    if (resolved.method === "oxylabs" && resolved.oxylabs) {
        try {
            composeOxylabsUsername(resolved.oxylabs);
        } catch (err) {
            printMsg(MSG.Err, `[!] Invalid Oxylabs config: ${err.message}`);
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
