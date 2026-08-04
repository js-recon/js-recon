import * as globalsUtil from "./globals.js";
import { printMsg, MSG } from "./printMsg.js";

/**
 * Configures the browser sandbox based on command-line flags and environment variables.
 * @param cmd - The commander command object.
 */
const configureSandbox = (cmd) => {
    if (process.env.IS_DOCKER === "true" || cmd.sandbox === false) {
        globalsUtil.setDisableSandbox(true);
        printMsg(MSG.Warn, `[!] Disabling browser sandbox`);
    }
};

export default configureSandbox;
