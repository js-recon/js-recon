import inquirer from "inquirer";
import { printMsg, MSG } from "../utility/printMsg.js";
import { writeMethodConfig } from "./configFile.js";
import { composeOxylabsUsername, type OxylabsConfig } from "./oxylabsProxy.js";

export interface ProxyOxylabsOptions {
    init: boolean;
    config: string;
    username?: string;
    password?: string;
    country?: string;
    city?: string;
    sessionId?: string;
}

/** Resolves the oxylabs config field-by-field: CLI flags where given, otherwise interactive prompts. */
const promptOxylabsConfig = async (opts: ProxyOxylabsOptions): Promise<OxylabsConfig> => {
    const answers = await inquirer.prompt([
        {
            type: "input",
            name: "username",
            message: "Oxylabs username",
            when: !opts.username,
            validate: (value: string) => !!value || "Username is required",
        },
        {
            type: "password",
            name: "password",
            mask: "*",
            message: "Oxylabs password",
            when: !opts.password,
            validate: (value: string) => !!value || "Password is required",
        },
        {
            type: "input",
            name: "country",
            message: "Country code (optional, e.g. US)",
            when: opts.country === undefined,
        },
        {
            type: "input",
            name: "city",
            message: "City (optional, requires country)",
            when: (currentAnswers: { country?: string }) =>
                opts.city === undefined && !!(opts.country || currentAnswers.country),
        },
        {
            type: "input",
            name: "sessionId",
            message: "Sticky session id (optional)",
            when: opts.sessionId === undefined,
        },
    ]);

    const cfg: OxylabsConfig = {
        username: opts.username || answers.username,
        password: opts.password || answers.password,
        country: opts.country || answers.country || undefined,
        city: opts.city || answers.city || undefined,
        sessionId: opts.sessionId || answers.sessionId || undefined,
    };
    composeOxylabsUsername(cfg); // throws if city/sessionId was given without support
    return cfg;
};

/**
 * Entry point for `proxy oxylabs`: writes an Oxylabs datacenter proxy config to
 * `.proxy_config.json`, resolving each field from CLI flags first and prompting interactively
 * for whatever's missing.
 *
 * @async
 * @param opts - Resolved CLI options for the `proxy oxylabs` subcommand.
 * @returns {Promise<void>}
 */
const proxyOxylabs = async (opts: ProxyOxylabsOptions): Promise<void> => {
    const configFile = opts.config || ".proxy_config.json";

    if (!opts.init) {
        printMsg(MSG.Err, "[!] Please provide a valid action (-i/--init)");
        return;
    }

    const oxylabsConfig = await promptOxylabsConfig(opts);
    writeMethodConfig(configFile, "oxylabs", oxylabsConfig);
    printMsg(MSG.Run, `[✓] Saved oxylabs proxy config to ${configFile}`);
};

export default proxyOxylabs;
