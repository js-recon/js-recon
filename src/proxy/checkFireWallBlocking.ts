import chalk from "chalk";
import detectBlockedResponse from "./detectBlockedResponse.js";

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
    const detection = detectBlockedResponse({ status: 503, body });
    if (!detection.blocked) return false;
    const provider = detection.provider === "cloudfront" ? "CloudFront" : "Cloudflare/CDN";
    console.error(chalk.red(`[!] ${provider} detected`));
    return true;
};

export default checkFireWallBlocking;
