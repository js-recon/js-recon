import inquirer from "inquirer";
import { printMsg, MSG } from "../utility/printMsg.js";
import { writeMethodConfig } from "./configFile.js";
import { parseProxyUrl } from "./genericProxy.js";

export interface ProxyUrlMethodOptions {
    init: boolean;
    config: string;
    url?: string;
}

/** Resolves the proxy URL: the `--url` flag if given (validated), otherwise an interactive prompt. */
const promptProxyUrl = async (method: "socks" | "http", urlInput?: string): Promise<string> => {
    if (urlInput) {
        parseProxyUrl(urlInput);
        return urlInput;
    }
    const example = method === "socks" ? "socks5://user:pass@host:1080" : "http://user:pass@host:8080";
    const { url } = await inquirer.prompt([
        {
            type: "input",
            name: "url",
            message: `${method === "socks" ? "SOCKS5" : "HTTP"} proxy URL (e.g. ${example})`,
            validate: (value: string) => {
                try {
                    parseProxyUrl(value);
                    return true;
                } catch (err) {
                    return err.message;
                }
            },
        },
    ]);
    return url;
};

/**
 * Shared entry point for `proxy socks` and `proxy http`: writes the resolved proxy URL to
 * `.proxy_config.json` under the given method's key.
 *
 * @async
 * @param method - "socks" or "http"
 * @param opts - Resolved CLI options for the subcommand.
 * @returns {Promise<void>}
 */
export const proxyUrlMethod = async (method: "socks" | "http", opts: ProxyUrlMethodOptions): Promise<void> => {
    const configFile = opts.config || ".proxy_config.json";

    if (!opts.init) {
        printMsg(MSG.Err, "[!] Please provide a valid action (-i/--init)");
        return;
    }

    const url = await promptProxyUrl(method, opts.url);
    writeMethodConfig(configFile, method, { url });
    printMsg(MSG.Run, `[✓] Saved ${method} proxy config to ${configFile}`);
};
