import { printMsg, MSG } from "../utility/printMsg.js";

/**
 * Checks if a response body contains signs of firewall or security system blocking.
 *
 * Currently detects Cloudflare protection pages by looking for specific HTML title patterns
 * that indicate the request was intercepted by a security system.
 *
 * @param body - The response body content to analyze for blocking indicators
 * @returns Promise that resolves to true if blocking is detected, false otherwise
 */
const checkFireWallBlocking = async (body: string): Promise<boolean> => {
    // check common signs of CF first
    if (body.includes("<title>Just a moment...</title>")) {
        printMsg(MSG.Err, "[!] Cloudflare detected");
        return true;
    } else if (body.includes("<title>Attention Required! | Cloudflare</title>")) {
        printMsg(MSG.Err, "[!] Cloudflare detected");
        return true;
    }

    return false;
};

export default checkFireWallBlocking;
