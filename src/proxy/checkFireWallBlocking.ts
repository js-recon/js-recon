import chalk from "chalk";
import detectBlockedResponse, { type BlockedResponseHeaders } from "./detectBlockedResponse.js";

/**
 * Sentinel status used when the caller has no real HTTP status available. Outside the
 * 400–599 range detectBlockedResponse's corroborated-status/generated-error paths require,
 * so omitting status *skips* those paths instead of spoofing a match against the wrong
 * denial-pattern set.
 */
const UNKNOWN_STATUS = 0;

export interface FirewallCheckContext {
    readonly status?: number;
    readonly headers?: BlockedResponseHeaders;
}

/**
 * Checks if a response body contains signs of firewall or security system blocking.
 *
 * Detects Cloudflare challenge pages from body content alone, and (when the caller can
 * supply the real HTTP status and headers) corroborated 403/429/503 WAF/CDN denial pages.
 *
 * @param body - The response body content to analyze for blocking indicators
 * @param context - The real HTTP status/headers, when available
 * @returns Promise that resolves to true if blocking is detected, false otherwise
 */
const checkFireWallBlocking = async (body: string, context: FirewallCheckContext = {}): Promise<boolean> => {
    const detection = detectBlockedResponse({
        status: context.status ?? UNKNOWN_STATUS,
        headers: context.headers,
        body,
    });
    if (!detection.blocked) return false;
    const provider = detection.provider === "cloudfront" ? "CloudFront" : "Cloudflare/CDN";
    console.error(chalk.red(`[!] ${provider} detected`));
    return true;
};

export default checkFireWallBlocking;
