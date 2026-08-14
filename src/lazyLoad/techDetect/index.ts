import chalk from "chalk";
import * as cheerio from "cheerio";
import makeRequest, { getActivePuppeteerProxyArgs } from "../../utility/makeReq.js";
import puppeteer from "../../utility/puppeteerInstance.js";
import * as globalsUtil from "../../utility/globals.js";
import { getChromiumPath } from "../../utility/getChromiumPath.js";
import path from "path";
import { checkNextJS } from "./checkNextJS.js";
import { isNextDevServer } from "./checkNextDevServer.js";
import { checkNuxtJS } from "./checkNuxtJS.js";
import { checkSvelte } from "./checkSvelte.js";
import { checkVueJS } from "./checkVueJS.js";
import { isVueDevServer } from "./checkVueDevServer.js";
import { checkAngularJS } from "./checkAngularJS.js";
import { checkReact } from "./checkReact.js";
import { isReactDevServer } from "./checkReactDevServer.js";
import { isValidInterceptedJsEvidence } from "./checkInterceptedEvidence.js";
import { isSigintHandlerActive } from "../../run/interruptHandler.js";
import { printMsg, MSG } from "../../utility/printMsg.js";
import { customHeadersToRecord } from "../../utility/customHeaders.js";

// Every request Puppeteer intercepted during the most recent frameworkDetect() call,
// including anything a runtime-injected script requested (e.g. Cloudflare's own
// bot-challenge script self-injecting via `element.innerHTML = "...;a.src='...';..."`) —
// a network capture generic tech's plain-fetch crawl has no way to see on its own,
// since the reference is only ever constructed by executing the page's JS live.
// Exposed as a getter rather than widening frameworkDetect's return type so the
// existing `{name, evidence} | null` contract (consumed by fingerprint/index.ts too)
// doesn't need to change everywhere.
let lastInterceptedUrls: string[] = [];

export const getLastInterceptedUrls = (): string[] => lastInterceptedUrls;

/**
 * Detects the front-end framework used in a webpage.
 * It does this by iterating through all HTML tags and checking if any attribute name starts with "data-v-".
 * It also checks for Nuxt.js by checking for "/_nuxt" paths in src or href attributes.
 * It also checks for SvelteKit-specific attributes
 * @param {string} url - The URL of the webpage to fetch and parse.
 * @returns {Promise<{name: string, evidence: string}>} - A promise that resolves to an object with two properties:
 *   - name: The name of the detected front-end framework.
 *   - evidence: A string with the evidence of the detection, or an empty string if no front-end framework was detected.
 */
const frameworkDetect = async (
    url: string,
    signal?: AbortSignal
): Promise<{ name: string; evidence: string } | null> => {
    const log = (...args: any[]) => {
        if (!globalsUtil.getQuiet()) printMsg(MSG.Plain, args.join(" "));
    };
    log(chalk.cyan("[i] Detecting front-end framework"));

    // get the page source. Drain the body immediately into a string — if we
    // wait until after the puppeteer + downstream check* calls, the Response
    // body gets invalidated (undici flips bodyUsed=true mid-flight when the
    // response is held idle alongside other in-flight fetches).
    if (signal?.aborted) return null;
    const res = await makeRequest(url, signal ? { signal } : {});
    let resBody: string | null = null;
    if (res !== null) {
        try {
            resBody = await res.text();
        } catch (err) {
            log(
                chalk.yellow(
                    `[!] Could not read fetch response body for ${url} (${(err as any)?.message || err}); using browser-rendered source only.`
                )
            );
        }
    }
    if (signal?.aborted) return null;

    // get the page source in the browser (skipped in cache-only mode — no network allowed)
    let pageSource = "";
    const interceptedUrls: string[] = [];
    // Keyed by URL: the response status/content-type/body for every request Puppeteer
    // saw during page load. Populated below so the intercepted-URL fallback can confirm
    // a framework-shaped URL's response actually looks like JS, not just its path shape.
    const responseEvidence = new Map<string, { status: number; contentType: string | null; body: string }>();
    if (!globalsUtil.getCacheOnly()) {
        const chromiumPath = getChromiumPath();
        const proxyArgs = getActivePuppeteerProxyArgs();
        let browser;
        try {
            browser = await puppeteer.launch({
                executablePath: chromiumPath,
                args: [
                    ...(globalsUtil.getDisableSandbox()
                        ? ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
                        : []),
                    ...(proxyArgs.arg ? [proxyArgs.arg] : []),
                ],
                handleSIGINT: !isSigintHandlerActive(),
            });
        } catch (err) {
            const message = (err as any)?.message || err;
            log(chalk.red(`[!] Puppeteer browser launch failed: ${message}`));
            throw new Error(`Puppeteer browser launch failed: ${message}`);
        }
        const abortBrowser = () => {
            void browser.close().catch(() => undefined);
        };
        signal?.addEventListener("abort", abortBrowser, { once: true });
        try {
            if (signal?.aborted) return null;
            const page = await browser.newPage();
            if (proxyArgs.authenticate) {
                await page.authenticate(proxyArgs.authenticate);
            }
            const customHeaders = customHeadersToRecord(globalsUtil.getCustomHeaders());
            if (Object.keys(customHeaders).length > 0) await page.setExtraHTTPHeaders(customHeaders);
            page.setDefaultNavigationTimeout(30000);

            const cdp = await page.createCDPSession();
            await cdp.send("Page.setDownloadBehavior", { behavior: "deny" });

            // Intercept all requests so framework-specific URL patterns (e.g. /_nuxt/, /_next/)
            // can be used as a detection signal even when they don't appear in parsed HTML.
            await page.setRequestInterception(true);
            page.on("request", (req) => {
                interceptedUrls.push(req.url());
                // Abort non-http/s schemes (mailto:, data:, etc.) — continue() throws for them.
                if (/^https?:\/\//i.test(req.url())) {
                    req.continue().catch(() => {});
                } else {
                    req.abort().catch(() => {});
                }
            });
            // Captures each response's status/content-type/body as it arrives — reading the
            // body must happen while the page/CDP session is still alive, so this can't be
            // deferred until after browser.close(). Body-read failures (redirects, aborted
            // responses) are swallowed to an empty string rather than dropping the entry.
            const responseBodyPromises: Promise<void>[] = [];
            page.on("response", (httpRes) => {
                const responseUrl = httpRes.url();
                const status = httpRes.status();
                const contentType = httpRes.headers()["content-type"] ?? null;
                responseBodyPromises.push(
                    httpRes
                        .text()
                        .catch(() => "")
                        .then((body) => {
                            responseEvidence.set(responseUrl, { status, contentType, body });
                        })
                );
            });
            try {
                await page.goto(url, {
                    waitUntil: "load",
                    timeout: 30000,
                });
                // If no framework URL was intercepted yet, we may have landed on a
                // bot-challenge page (e.g. Vercel's challenge.v2.min.js) that fires
                // its own load event before JS-redirecting to the real app. Wait for
                // that redirect navigation; on sites with no redirect this times out
                // quickly and we continue with what we have.
                const hasFrameworkSignal = interceptedUrls.some(
                    (u) => u.includes("/_next/") || u.includes("/_nuxt/") || u.includes("/_app/immutable/")
                );
                if (!hasFrameworkSignal) {
                    await page.waitForNavigation({ waitUntil: "load", timeout: 5000 }).catch(() => {});
                }
                // Give client-side frameworks a brief window to settle, unless cancellation
                // has already closed the browser and made the result irrelevant.
                if (!signal?.aborted) {
                    await new Promise<void>((resolve) => {
                        const finish = () => {
                            clearTimeout(timeout);
                            signal?.removeEventListener("abort", finish);
                            resolve();
                        };
                        const timeout = setTimeout(finish, 2000);
                        signal?.addEventListener("abort", finish, { once: true });
                    });
                }
                if (!signal?.aborted) pageSource = await page.content();
            } catch {
                if (!signal?.aborted) {
                    log(
                        chalk.yellow("[!] Page navigation/content failed, falling back to fetch response if available")
                    );
                }
            } finally {
                await Promise.allSettled(responseBodyPromises);
            }
        } catch (err) {
            if (signal?.aborted) return null;
            throw err;
        } finally {
            signal?.removeEventListener("abort", abortBrowser);
            await browser.close().catch(() => {});
        }
    }
    lastInterceptedUrls = interceptedUrls;

    if (signal?.aborted) return null;

    // if (res === null || res === undefined) {
    //   return;
    // }

    // const pageSource = await res.text();

    // cheerio to parse the page source
    const $ = cheerio.load(pageSource);

    // there are two checks
    // one is directly on the response the tool gets by making request with fetch ($)
    // and the second one is by opening the page in browser, loading content, and then analyzing the page content ($res)

    // check all technologies one by one
    const result_checkNextJS = await checkNextJS($);
    const result_checkVueJS = await checkVueJS($, url);
    const result_checkSvelte = await checkSvelte($);
    const result_checkAngular = await checkAngularJS($, url);
    const result_checkReact = await checkReact($, url);

    // now, also check with the res response
    let result_checkNextJS_res = { detected: false, evidence: "" };
    let result_checkVueJS_res = { detected: false, evidence: "" };
    let result_checkSvelte_res = { detected: false, evidence: "" };
    let result_checkAngularJS_res = { detected: false, evidence: "" };
    let result_checkReact_res = { detected: false, evidence: "" };

    let $res;
    // if network error was caused, then return
    if (res === null) {
        log(chalk.red("[!] Fetch request failed after retries"));
    } else if (resBody !== null) {
        $res = cheerio.load(resBody);
        result_checkNextJS_res = await checkNextJS($res);
        result_checkVueJS_res = await checkVueJS($res, url);
        result_checkSvelte_res = await checkSvelte($res);
        result_checkAngularJS_res = await checkAngularJS($res, url);
        result_checkReact_res = await checkReact($res, url);
    }

    if (result_checkNextJS.detected === true || result_checkNextJS_res.detected === true) {
        const evidence =
            result_checkNextJS.evidence !== "" ? result_checkNextJS.evidence : result_checkNextJS_res.evidence;
        const isDevServer =
            isNextDevServer($, url, interceptedUrls) || ($res ? isNextDevServer($res, url, interceptedUrls) : false);
        return { name: isDevServer ? "next-dev" : "next", evidence };
    } else if (result_checkVueJS.detected === true || result_checkVueJS_res.detected === true) {
        log(chalk.green("[✓] Vue.js detected"));
        log(chalk.cyan(`[i] Checking Nuxt.JS`), chalk.dim("(Nuxt.JS is built on Vue.js)"));
        const result_checkNuxtJS = await checkNuxtJS($);
        const result_checkNuxtJS_res = $res ? await checkNuxtJS($res) : { detected: false, evidence: "" };
        if (result_checkNuxtJS.detected === true || result_checkNuxtJS_res.detected === true) {
            const evidence =
                result_checkNuxtJS.evidence !== "" ? result_checkNuxtJS.evidence : result_checkNuxtJS_res.evidence;
            return { name: "nuxt", evidence };
        }
        const evidence =
            result_checkVueJS.evidence !== "" ? result_checkVueJS.evidence : result_checkVueJS_res.evidence;
        const isDevServer =
            isVueDevServer($, url, interceptedUrls) || ($res ? isVueDevServer($res, url, interceptedUrls) : false);
        return { name: isDevServer ? "vue-dev" : "vue", evidence };
    } else if (result_checkSvelte.detected === true || result_checkSvelte_res.detected === true) {
        const evidence =
            result_checkSvelte.evidence !== "" ? result_checkSvelte.evidence : result_checkSvelte_res.evidence;
        return { name: "svelte", evidence };
    } else if (result_checkAngular.detected === true || result_checkAngularJS_res.detected === true) {
        const evidence =
            result_checkAngular.evidence !== "" ? result_checkAngular.evidence : result_checkAngularJS_res.evidence;
        return { name: "angular", evidence };
    } else if (result_checkReact.detected === true || result_checkReact_res.detected === true) {
        const evidence =
            result_checkReact.evidence !== "" ? result_checkReact.evidence : result_checkReact_res.evidence;
        const isDevServer =
            (await isReactDevServer($, url, interceptedUrls)) ||
            ($res ? await isReactDevServer($res, url, interceptedUrls) : false);
        return { name: isDevServer ? "react-dev" : "react", evidence };
    }

    // Fallback: check URLs intercepted by Puppeteer during page load.
    // Some sites load framework chunks dynamically via JavaScript rather than referencing
    // them in static HTML attributes — those won't be caught by the HTML-based checks above.
    // A path-shape match alone isn't sufficient evidence, though — a framework-shaped path
    // that actually resolves to an error/maintenance page would otherwise be enough to
    // mis-fingerprint the whole target. Only accept the match once the captured response
    // for that URL confirms it's a genuine 2xx JS response.
    for (const interceptedUrl of interceptedUrls) {
        let candidateName: string | null = null;
        if (interceptedUrl.includes("/_nuxt/")) {
            candidateName = "nuxt";
        } else if (interceptedUrl.includes("/_next/")) {
            candidateName = isNextDevServer($, url, [interceptedUrl]) ? "next-dev" : "next";
        } else if (interceptedUrl.includes("/_app/immutable/")) {
            candidateName = "svelte";
        } else if (interceptedUrl.includes("/@react-refresh")) {
            // Vite React plugin dev-mode HMR runtime — requested by every Vite/React dev server.
            candidateName = "react-dev";
        }
        // No /@vite/client fallback arm here: unlike /_next/ or /@react-refresh, the Vite dev
        // client is framework-agnostic (React, Svelte, Solid, and vanilla Vite apps request it
        // too), so it can't be used to identify Vue specifically without a Vue-detection signal
        // to pair it with. The HTML-level isVueDevServer() check above already covers the
        // primary case (Vue's entry script tag showing up in static HTML).
        if (candidateName === null) continue;

        const evidence = responseEvidence.get(interceptedUrl);
        if (evidence && isValidInterceptedJsEvidence(evidence.status, evidence.contentType, evidence.body)) {
            return { name: candidateName, evidence: `intercepted request: ${interceptedUrl}` };
        }
        log(
            chalk.yellow(
                `[!] Framework-shaped URL rejected as detection evidence (response is not JS): ${interceptedUrl}`
            )
        );
    }

    return null;
};

export default frameworkDetect;
