import chalk from "chalk";
import checkFireWallBlocking from "./checkFireWallBlocking.js";
import { proxyFeasibilityRequest } from "./proxyFeasibilityRequest.js";
import type { ResolvedProxyConfig } from "./resolveProxyConfig.js";

/** Number of requests sent through the proxy method before concluding it reliably bypasses the firewall. */
const PROXY_CHECK_REQUESTS = 10;

export interface FeasibilityOutcome {
    code: number;
    message: string;
}

/**
 * Decides the `--feasibility` outcome from the two detection stages.
 *
 * - No firewall without a proxy: a proxy isn't needed for this target (exit 27).
 * - Firewall present without a proxy, and still present with the proxy: the proxy couldn't
 *   bypass it (exit 28).
 * - Firewall present without a proxy, but not present with the proxy: the proxy works (exit 0).
 *
 * @param blockedWithoutProxy - Whether the firewall was detected on the direct (no-proxy) request.
 * @param blockedWithProxy - Whether the firewall was detected while routed through the proxy.
 * @returns The exit code and message to print for this outcome.
 */
export const determineFeasibilityOutcome = (
    blockedWithoutProxy: boolean,
    blockedWithProxy: boolean
): FeasibilityOutcome => {
    if (!blockedWithoutProxy) {
        return {
            code: 27,
            message: "[i] No firewall detected without a proxy. A proxy is not needed for this target.",
        };
    }
    if (blockedWithProxy) {
        return {
            code: 28,
            message: "[!] Firewall still detected while using the proxy. This proxy method could not bypass it.",
        };
    }
    return {
        code: 0,
        message:
            "[✓] Firewall detected without a proxy, but not detected when using the proxy. Please use a proxy for this target.",
    };
};

/**
 * Probes whether a proxy is needed and able to bypass a firewall/WAF in front of a target.
 *
 * Requests the target directly first. If no firewall is detected, a proxy isn't needed. If a
 * firewall is detected, retries through the resolved proxy method to see whether it's bypassed.
 * Does not print or exit — callers decide what to do with the outcome (`checkFeasibility` below
 * exits with its code for the CLI; `run`'s `--proxy-waf-fallback` uses it to decide whether to use
 * the proxy or skip the target).
 *
 * @param resolved - The resolved proxy config (method + its fields) to test.
 * @param url - The target URL to test.
 * @returns The feasibility outcome.
 */
export const probeFeasibility = async (resolved: ResolvedProxyConfig, url: string): Promise<FeasibilityOutcome> => {
    console.log(chalk.cyan(`[i] Checking feasibility of the "${resolved.method}" proxy method with ${url}`));
    const directResponse = await fetch(url);
    const directBody = await directResponse.text();
    const blockedWithoutProxy = await checkFireWallBlocking(directBody, {
        status: directResponse.status,
        headers: directResponse.headers,
    });

    let blockedWithProxy = false;
    if (blockedWithoutProxy) {
        for (let i = 0; i < PROXY_CHECK_REQUESTS; i++) {
            const { body, status, headers } = await proxyFeasibilityRequest(resolved, url);
            if (await checkFireWallBlocking(body, { status, headers })) {
                blockedWithProxy = true;
                break;
            }
        }
    }

    return determineFeasibilityOutcome(blockedWithoutProxy, blockedWithProxy);
};

/**
 * Checks the feasibility of using a proxy to bypass a firewall/WAF in front of a target, prints the
 * result, and exits with the outcome's code. Thin CLI wrapper around `probeFeasibility`.
 *
 * @param resolved - The resolved proxy config (method + its fields) to test.
 * @param url - The target URL to test.
 * @returns Promise that resolves when the feasibility check is complete.
 */
const checkFeasibility = async (resolved: ResolvedProxyConfig, url: string): Promise<void> => {
    try {
        const outcome = await probeFeasibility(resolved, url);
        console.log(outcome.code === 0 ? chalk.green(outcome.message) : chalk.magenta(outcome.message));
        process.exit(outcome.code);
    } catch (error) {
        console.error(chalk.red(`[!] An error occured in feasibility check: ${error}`));
    }
};

export default checkFeasibility;
