import chalk from "chalk";
import { ProxyAgent, Socks5ProxyAgent, type Dispatcher } from "undici";
import puppeteer from "./puppeteerInstance.js";
import { getChromiumPath } from "./getChromiumPath.js";
import * as globals from "./globals.js";
import { get } from "../proxy/genReq.js";
import checkFireWallBlocking from "../proxy/checkFireWallBlocking.js";
import { parseProxyUrl } from "../proxy/genericProxy.js";
import { buildOxylabsProxyUrl, composeOxylabsUsername } from "../proxy/oxylabsProxy.js";
import type { ResolvedProxyConfig } from "../proxy/resolveProxyConfig.js";
import fs from "fs";
import { EventEmitter } from "events";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { progressError, progressLog } from "./progressLog.js";
import { isSigintHandlerActive } from "../run/interruptHandler.js";

/**
 * Proxy-wiring layer. This is the single place a resolved proxy config (see
 * `../proxy/resolveProxyConfig.ts`) is turned into an actual dispatcher/launch args — every
 * request-issuing call site (Puppeteer launches here and in `lazyLoad/`, `initRules.ts`'s rules
 * download) imports these helpers rather than re-deriving proxy semantics itself.
 */

/** Reconstructs a ResolvedProxyConfig from the current proxy-related globals. */
export const getResolvedProxyConfigFromGlobals = (): ResolvedProxyConfig => {
    return {
        method: globals.getProxyMethod(),
        url: globals.getProxyUrl(),
        oxylabs: globals.getOxylabsConfig(),
    };
};

/** `RequestInit` extended with undici's `dispatcher` option (absent from the DOM lib's fetch types). */
export type FetchOptsWithDispatcher = RequestInit & { dispatcher?: Dispatcher };

/** Merges a proxy dispatcher (derived from the current globals) into fetch options, if a proxy is configured. */
export const withProxyDispatcher = (opts: RequestInit = {}): FetchOptsWithDispatcher => {
    const dispatcher = buildUndiciDispatcher(getResolvedProxyConfigFromGlobals());
    return dispatcher ? { ...opts, dispatcher } : opts;
};

/**
 * Builds an undici dispatcher for the resolved proxy config, to pass as `fetch(url, { dispatcher })`.
 * Returns null for the `aws` method (routed separately via genReq.ts) or no proxy configured.
 */
export const buildUndiciDispatcher = (resolved: ResolvedProxyConfig): Dispatcher | null => {
    if (resolved.method === "socks") {
        if (!resolved.url) return null;
        parseProxyUrl(resolved.url); // validates before constructing the agent
        return new Socks5ProxyAgent(resolved.url);
    }
    if (resolved.method === "http") {
        if (!resolved.url) return null;
        parseProxyUrl(resolved.url); // validates before constructing the agent
        return new ProxyAgent(resolved.url);
    }
    if (resolved.method === "oxylabs") {
        if (!resolved.oxylabs) return null;
        return new ProxyAgent(buildOxylabsProxyUrl(resolved.oxylabs));
    }
    return null;
};

export interface PuppeteerProxyArgs {
    arg: string | null;
    authenticate?: { username: string; password: string };
}

const requestSignalContext = new AsyncLocalStorage<AbortSignal>();

/** Supplies cancellation to every makeRequest call in the async work scope. */
export const withRequestSignal = <T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> =>
    requestSignalContext.run(signal, work);

/** True when the current async request scope has been cancelled. */
export const isRequestCancelled = (): boolean => requestSignalContext.getStore()?.aborted === true;

/**
 * Builds the Puppeteer `--proxy-server=` launch arg plus optional `page.authenticate()` credentials.
 * `aws` never applies here (Puppeteer never went through API Gateway).
 */
export const buildPuppeteerProxyArgs = (resolved: ResolvedProxyConfig): PuppeteerProxyArgs => {
    if (resolved.method === "socks" || resolved.method === "http") {
        if (!resolved.url) return { arg: null };
        const parsed = parseProxyUrl(resolved.url);
        const arg = `--proxy-server=${parsed.protocol}://${parsed.host}:${parsed.port}`;
        if (parsed.username && parsed.password) {
            return { arg, authenticate: { username: parsed.username, password: parsed.password } };
        }
        return { arg };
    }
    if (resolved.method === "oxylabs") {
        if (!resolved.oxylabs) return { arg: null };
        return {
            arg: "--proxy-server=pr.oxylabs.io:7777",
            authenticate: {
                username: composeOxylabsUsername(resolved.oxylabs),
                password: resolved.oxylabs.password,
            },
        };
    }
    return { arg: null };
};

const reportFailure = (url: string, err: unknown): void => {
    if (globals.getCacheOnly()) {
        progressError(chalk.dim(`[!] Cache miss (cache-only mode): ${url}`));
        return;
    }
    progressError(chalk.red(`[!] Failed to fetch ${url} : ${err}`));
    if (!globals.getInsecure()) {
        progressLog(chalk.dim("[i] Often, using -k flag (ignore SSL errors) fixes the problem"));
    }
};

const reportTimeout = (url: string, requestTimeout: number): void => {
    progressError(chalk.red(`[!] Request to ${url} timed out after ${requestTimeout}ms`));
};

const reportInvalidUrl = (url: string): void => {
    progressError(chalk.red(`[!] Invalid request URL: ${url}`));
};

// random user agents
const UAs = [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
];

interface CacheEntry {
    readonly identityDigest: string;
    readonly status: number;
    readonly statusText: string;
    readonly bodyBase64: string;
    readonly responseHeaders: Readonly<Record<string, string>>;
}

const getCacheIdentityDigest = (url: string, headers: {}): string => {
    const normalizedHeaders = [...new Headers(headers as HeadersInit).entries()].sort(([left], [right]) =>
        left.localeCompare(right)
    );
    return createHash("sha256")
        .update(JSON.stringify([url, normalizedHeaders]))
        .digest("hex");
};

const getCacheEntryPath = (url: string, headers: {}): string => {
    const digest = getCacheIdentityDigest(url, headers);
    return `${globals.getRespCacheFile()}.entries/${digest}.json`;
};

/**
 * Reads response data from cache for future requests.
 *
 * If the cache file exists, and the given URL is present in the cache,
 * it checks if the response contains the specific request headers. If it does,
 * it builds a Response object with the cached data and returns it.
 *
 * If the response does not contain the request headers, or if the cache file
 * does not exist, or if the URL is not present in the cache, it returns null.
 *
 * @param url - The URL to read the cache for
 * @param headers - Request headers that were used
 * @returns A Promise that resolves to a Response object if the cache is found, or null if not
 */
const readCache = async (url: string, headers: {}): Promise<Response | null> => {
    const identityDigest = getCacheIdentityDigest(url, headers);
    const entryPath = getCacheEntryPath(url, headers);
    if (fs.existsSync(entryPath)) {
        try {
            const entry = JSON.parse(fs.readFileSync(entryPath, "utf-8")) as CacheEntry;
            if (entry.identityDigest === identityDigest) {
                return new Response(Buffer.from(entry.bodyBase64, "base64"), {
                    status: entry.status,
                    statusText: entry.statusText,
                    headers: entry.responseHeaders,
                });
            }
        } catch {
            // Ignore corrupt sidecar entries and fall back to the legacy cache.
        }
    }

    // first, check if the file exists or not
    if (!fs.existsSync(globals.getRespCacheFile())) {
        return null;
    }

    // console.log("reading cache for", url);
    // open the cache file, build a Response, and return
    let cache: Record<string, any>;
    try {
        cache = JSON.parse(fs.readFileSync(globals.getRespCacheFile(), "utf-8"));
    } catch {
        return null;
    }
    if (cache[url]) {
        // check if the response contains the specific request headers
        // iterate through cache[url] and build a Response

        // first check if the essential headers match
        const rscEnabled = headers["RSC"] ? true : false;
        if (rscEnabled) {
            if (cache[url].rsc) {
                return new Response(Buffer.from(cache[url].rsc.body_b64, "base64"), {
                    status: cache[url].rsc.status,
                    headers: cache[url].rsc.resp_headers,
                });
            }
        }
        if (!rscEnabled && cache[url] && cache[url].normal) {
            return new Response(Buffer.from(cache[url].normal.body_b64, "base64"), {
                status: cache[url].normal.status,
                headers: cache[url].normal.resp_headers,
            });
        }
    }
    // console.log("cache not found for ", url);
    return null;
};

/**
 * Writes response data to cache for future requests.
 *
 * Stores one atomic sidecar entry per URL/request-header identity. The legacy
 * JSON cache remains readable, but new writes avoid whole-cache rewrites.
 *
 * @param url - The URL to cache the response for
 * @param headers - Request headers that were used
 * @param response - The Response object to cache
 * @returns Promise that resolves when caching is complete
 */
const writeCache = async (
    url: string,
    headers: {},
    response: Response,
    reportErrors: boolean = true,
    signal?: AbortSignal
): Promise<void> => {
    if (signal?.aborted) return;
    try {
        await writeCacheUnsafe(url, headers, response, signal);
    } catch (err) {
        // Caching must never break a request. Log and move on.
        if (reportErrors) {
            progressError(chalk.yellow(`[!] Failed to write response cache for ${url}: ${err?.message || err}`));
        }
    }
};

const writeCacheUnsafe = async (url: string, headers: {}, response: Response, signal?: AbortSignal): Promise<void> => {
    if (signal?.aborted) return;
    const identityDigest = getCacheIdentityDigest(url, headers);
    const entryPath = getCacheEntryPath(url, headers);
    if (fs.existsSync(entryPath)) return;

    const clonedResponse = response.clone();
    const bodyBuffer = Buffer.from(await clonedResponse.arrayBuffer());
    if (signal?.aborted) return;
    const entry: CacheEntry = Object.freeze({
        identityDigest,
        status: clonedResponse.status,
        statusText: clonedResponse.statusText,
        bodyBase64: bodyBuffer.toString("base64"),
        responseHeaders: Object.freeze(Object.fromEntries(clonedResponse.headers.entries())),
    });
    const entryDirectory = `${globals.getRespCacheFile()}.entries`;
    fs.mkdirSync(entryDirectory, { recursive: true });
    const temporaryPath = `${entryPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
        fs.writeFileSync(temporaryPath, JSON.stringify(entry));
        if (signal?.aborted) return;
        fs.renameSync(temporaryPath, entryPath);
    } finally {
        if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    }
};

/**
 * Performs a single fetch request with retry logic.
 *
 * @param url - The URL to request
 * @param requestOptions - Request options including headers
 * @param requestTimeout - Timeout in milliseconds
 * @returns A Promise that resolves to a Response, or null if all retries fail
 */
const singleFetch = async (
    url: string,
    requestOptions: RequestInit,
    requestTimeout: number,
    reportErrors: boolean = true
): Promise<Response | null> => {
    let res: Response;
    let counter = 0;

    while (true) {
        const controller = new AbortController();
        let timedOut = false;
        const timeoutId = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, requestTimeout);
        const upstreamSignal = requestOptions.signal;
        const abortFromUpstream = () => controller.abort();
        if (upstreamSignal?.aborted) {
            controller.abort();
            clearTimeout(timeoutId);
            return null;
        } else {
            upstreamSignal?.addEventListener("abort", abortFromUpstream, { once: true });
        }
        const currentRequestOptions = withProxyDispatcher({
            ...requestOptions,
            signal: controller.signal,
        });

        try {
            EventEmitter.defaultMaxListeners = 20;
            res = await fetch(url, currentRequestOptions);
            clearTimeout(timeoutId);
            upstreamSignal?.removeEventListener("abort", abortFromUpstream);
            if (res) {
                break;
            }
        } catch (err) {
            clearTimeout(timeoutId);
            upstreamSignal?.removeEventListener("abort", abortFromUpstream);
            counter++;
            // BUG: https://github.com/nodejs/node/issues/47246
            if (err.cause && err.cause.code === "UND_ERR_HEADERS_OVERFLOW") {
                progressError(
                    chalk.yellow(
                        `[!] The tool detected a header overflow. Please increase the limit by setting environment variable \`NODE_OPTIONS="--max-http-header-size=99999999"\`. If the error still persists, please try again with a higher limit.`
                    )
                );
                process.exit(21);
            }
            if (err.name === "AbortError") {
                if (reportErrors && (timedOut || !upstreamSignal?.aborted)) reportTimeout(url, requestTimeout);
                return null;
            }
            if (counter > 10) {
                if (reportErrors) reportFailure(url, err);
                return null;
            }
            // sleep 0.5 s before retrying
            await new Promise((resolve) => setTimeout(resolve, 500));
            continue;
        }
    }
    return res;
};

/**
 * Handles firewall detection and bypass using headless browser.
 *
 * @param url - The URL being requested
 * @param resp_text - The response text to check for firewall signatures
 * @returns A Promise that resolves to Response content if firewall detected, or null if not
 */
const handleFirewall = async (
    url: string,
    responseText: string,
    signal?: AbortSignal,
    reportErrors: boolean = true
): Promise<string | null> => {
    const firewall =
        responseText.includes("/?bm-verify=") || responseText.includes("<title>Just a moment...</title>")
            ? "CF"
            : responseText.includes("403 ERROR") && responseText.includes("Generated by cloudfront")
              ? "Cloudfront"
              : null;
    if (!firewall || signal?.aborted) return null;

    if (reportErrors) {
        progressError(chalk.yellow(`[!] ${firewall} Firewall detected. Trying to bypass with headless browser`));
    }
    const chromiumPath = getChromiumPath();
    const proxyArgs = buildPuppeteerProxyArgs(getResolvedProxyConfigFromGlobals());
    const browser = await puppeteer.launch({
        headless: true,
        executablePath: chromiumPath,
        args: [
            ...(globals.getDisableSandbox()
                ? ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
                : []),
            ...(proxyArgs.arg ? [proxyArgs.arg] : []),
        ],
        handleSIGINT: !isSigintHandlerActive(),
    });
    const abortBrowser = () => {
        void browser.close().catch(() => undefined);
    };
    signal?.addEventListener("abort", abortBrowser, { once: true });

    try {
        if (signal?.aborted) return null;
        const page = await browser.newPage();
        if (proxyArgs.authenticate) await page.authenticate(proxyArgs.authenticate);
        await page.goto(url);
        if (signal?.aborted) return null;
        await new Promise<void>((resolve) => {
            const finish = () => {
                clearTimeout(timeout);
                signal?.removeEventListener("abort", finish);
                resolve();
            };
            const timeout = setTimeout(finish, 5000);
            signal?.addEventListener("abort", finish, { once: true });
        });
        return signal?.aborted ? null : await page.content();
    } catch (err) {
        if (signal?.aborted) return null;
        throw err;
    } finally {
        signal?.removeEventListener("abort", abortBrowser);
        await browser.close().catch(() => undefined);
    }
};

/**
 * Makes a GET request to the given URL and returns the response.
 *
 * If caching is enabled, it will first check if the response is cached.
 * If it is, it will return the cached response. If not, it will make the request
 * using the given options, and cache the response before returning it.
 *
 * When no custom headers are provided, tries both with and without Referer header,
 * returning the successful (200) response.
 *
 * If the request fails, it will retry up to 10 times with 0.5s of sleep in between.
 * If all retries fail, it will return null.
 *
 * @param url - The URL to request
 * @param args - Request options
 * @returns A Promise that resolves to a Response, or null if all retries fail
 */
const makeRequest = async (
    url: string,
    args?: Omit<RequestInit, "timeout"> & { timeout?: number; reportErrors?: boolean }
): Promise<Response | null> => {
    if (url.startsWith("//")) {
        url = "https:" + url;
    }
    const { timeout, reportErrors = true, ...restArgs } = args || {};
    const contextualSignal = requestSignalContext.getStore();
    const explicitSignal = restArgs.signal ?? undefined;
    const effectiveSignal =
        contextualSignal && explicitSignal && contextualSignal !== explicitSignal
            ? AbortSignal.any([contextualSignal, explicitSignal])
            : (explicitSignal ?? contextualSignal);
    const isCancelled = (): boolean => effectiveSignal?.aborted === true;
    if (isCancelled()) return null;
    const requestTimeout = timeout || globals.getRequestTimeout();
    const usingDefaultHeaders = !restArgs.headers;

    // Build default headers if not provided
    const baseHeaders = {
        "User-Agent": UAs[Math.floor(Math.random() * UAs.length)],
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
        "Accept-Language": "en-US,en;q=0.9",
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Dest": "empty",
    };

    let parsedOrigin: string | null = null;
    try {
        parsedOrigin = new URL(url).origin;
    } catch {
        if (reportErrors) reportInvalidUrl(url);
        return null;
    }
    const requestOptions: RequestInit = {
        ...restArgs,
        ...(effectiveSignal ? { signal: effectiveSignal } : {}),
        headers:
            restArgs.headers ??
            ({
                ...baseHeaders,
                Referer: parsedOrigin,
                Origin: parsedOrigin,
            } satisfies HeadersInit),
    };

    // A successful default-header request may have used the no-Referer fallback.
    // Probe both request identities so that response remains reusable on later
    // runs, including cache-only runs that cannot repeat the network fallback.
    const cacheHeaderCandidates: readonly HeadersInit[] = usingDefaultHeaders
        ? [requestOptions.headers || {}, baseHeaders]
        : [requestOptions.headers || {}];

    // if cache is enabled, read the cache and return if cache is present. else, continue
    if (!globals.getDisableCache()) {
        let cachedEntry: Readonly<{ response: Response; headers: HeadersInit }> | null = null;
        for (const candidateHeaders of cacheHeaderCandidates) {
            const response = await readCache(url, candidateHeaders);
            if (response !== null) {
                cachedEntry = Object.freeze({ response, headers: candidateHeaders });
                break;
            }
        }
        if (isCancelled()) return null;

        // if the response if cached, then check if contains any signatures of firewall
        if (cachedEntry !== null) {
            const cachedText = await cachedEntry.response.clone().text();
            if (isCancelled()) return null;
            const firewallContent = await handleFirewall(url, cachedText, effectiveSignal, reportErrors);
            if (isCancelled()) return null;
            if (firewallContent) {
                await writeCache(
                    url,
                    cachedEntry.headers,
                    new Response(firewallContent),
                    reportErrors,
                    effectiveSignal
                );
                if (isCancelled()) return null;
                return new Response(firewallContent);
            }
            return cachedEntry.response;
        }
    }

    if (globals.getCacheOnly()) {
        if (reportErrors) reportFailure(url, "cache miss in cache-only mode");
        return null;
    }

    if (globals.getUseProxy() && globals.getProxyMethod() === "aws") {
        const getHeaders = Object.fromEntries(new Headers(requestOptions.headers).entries());

        let body: string;
        try {
            body = await get(url, getHeaders, effectiveSignal);
        } catch (err) {
            if (isCancelled()) return null;
            if (reportErrors) reportFailure(url, err);
            return null;
        }
        if (isCancelled()) return null;

        // check if any firewall is there in the way
        if (await checkFireWallBlocking(body)) {
            progressError(chalk.magenta("[!] Please try again without API Gateway"));
            process.exit(18);
        }

        // craft a Response, and return that
        const response = new Response(body);

        // if cache is enabled, write the response to the cache
        if (!globals.getDisableCache()) {
            await writeCache(url, getHeaders, response, reportErrors, effectiveSignal);
        }
        if (isCancelled()) return null;
        return response;
    } else {
        // Helper to read response once and store data for reuse.
        // We copy the bytes into a Buffer that owns its own ArrayBuffer so the
        // stored body cannot be invalidated by undici recycling its internal
        // buffer after we consume the response.
        const consumeResponse = async (
            res: Response | null
        ): Promise<{ body: Buffer; status: number; headers: Headers; ok: boolean; text: string } | null> => {
            if (!res || isCancelled()) return null;
            const ab = await res.arrayBuffer();
            if (isCancelled()) return null;
            const body = Buffer.alloc(ab.byteLength);
            body.set(new Uint8Array(ab));
            const text = body.toString("utf-8");
            // Snapshot headers as a plain object so we can rebuild a fresh
            // Headers instance per Response instead of sharing state.
            const headers = new Headers(res.headers);
            return { body, status: res.status, headers, ok: res.ok, text };
        };

        // Helper to create Response from stored data. Pass the body as an
        // immutable string so each Response gets a fully independent backing
        // store; undici has been known to flag Responses as already-consumed
        // when buffer-backed bodies share underlying memory. Strip headers
        // that no longer match the decoded body (content-length / encoding).
        const createResponse = (data: { body: Buffer; status: number; headers: Headers; text?: string }): Response => {
            // Copy bytes into a fresh Uint8Array so each Response owns its
            // backing memory — text decoding would corrupt binary payloads.
            const bodyCopy = new Uint8Array(data.body.byteLength);
            bodyCopy.set(data.body);
            const headers = new Headers(data.headers);
            headers.delete("content-length");
            headers.delete("content-encoding");
            headers.delete("transfer-encoding");
            return new Response(bodyCopy, { status: data.status, headers });
        };

        // When using default headers, try both with and without Referer/Origin
        // to handle servers that return 404 for one but 200 for the other
        if (usingDefaultHeaders) {
            // First try: with Referer and Origin
            const headersWithReferer = {
                ...baseHeaders,
                Referer: new URL(url).origin,
                Origin: new URL(url).origin,
            };
            const resWithReferer = await singleFetch(
                url,
                { ...requestOptions, headers: headersWithReferer },
                requestTimeout,
                false
            );
            const dataWithReferer = await consumeResponse(resWithReferer);
            if (isCancelled()) return null;

            if (dataWithReferer && dataWithReferer.ok) {
                // Check for firewall
                const firewallContent = await handleFirewall(url, dataWithReferer.text, effectiveSignal, reportErrors);
                if (isCancelled()) return null;
                if (firewallContent) {
                    if (!globals.getDisableCache()) {
                        await writeCache(
                            url,
                            headersWithReferer,
                            new Response(firewallContent),
                            reportErrors,
                            effectiveSignal
                        );
                    }
                    if (isCancelled()) return null;
                    return new Response(firewallContent);
                }

                // Cache and return successful response
                if (!globals.getDisableCache()) {
                    await writeCache(
                        url,
                        headersWithReferer,
                        createResponse(dataWithReferer),
                        reportErrors,
                        effectiveSignal
                    );
                }
                if (isCancelled()) return null;
                return createResponse(dataWithReferer);
            }

            // Second try: without Referer and Origin
            const headersWithoutReferer = { ...baseHeaders };
            const resWithoutReferer = await singleFetch(
                url,
                { ...requestOptions, headers: headersWithoutReferer },
                requestTimeout,
                reportErrors && !dataWithReferer
            );
            const dataWithoutReferer = await consumeResponse(resWithoutReferer);
            if (isCancelled()) return null;

            if (dataWithoutReferer && dataWithoutReferer.ok) {
                // Check for firewall
                const firewallContent = await handleFirewall(
                    url,
                    dataWithoutReferer.text,
                    effectiveSignal,
                    reportErrors
                );
                if (isCancelled()) return null;
                if (firewallContent) {
                    if (!globals.getDisableCache()) {
                        await writeCache(
                            url,
                            headersWithoutReferer,
                            new Response(firewallContent),
                            reportErrors,
                            effectiveSignal
                        );
                    }
                    if (isCancelled()) return null;
                    return new Response(firewallContent);
                }

                // Cache and return successful response
                if (!globals.getDisableCache()) {
                    await writeCache(
                        url,
                        headersWithoutReferer,
                        createResponse(dataWithoutReferer),
                        reportErrors,
                        effectiveSignal
                    );
                }
                if (isCancelled()) return null;
                return createResponse(dataWithoutReferer);
            }

            // Both failed, return whichever response we got (prefer non-null)
            const finalData = dataWithReferer || dataWithoutReferer;
            if (finalData) {
                if (!globals.getDisableCache()) {
                    await writeCache(url, headersWithReferer, createResponse(finalData), reportErrors, effectiveSignal);
                }
                if (isCancelled()) return null;
                return createResponse(finalData);
            }
            return null;
        } else {
            // Custom headers provided, use them directly
            const res = await singleFetch(url, requestOptions, requestTimeout, reportErrors);
            const data = await consumeResponse(res);
            if (!data || isCancelled()) return null;

            // Check for firewall
            const firewallContent = await handleFirewall(url, data.text, effectiveSignal, reportErrors);
            if (isCancelled()) return null;
            if (firewallContent) {
                if (!globals.getDisableCache()) {
                    await writeCache(
                        url,
                        requestOptions.headers || {},
                        new Response(firewallContent),
                        reportErrors,
                        effectiveSignal
                    );
                }
                if (isCancelled()) return null;
                return new Response(firewallContent);
            }

            // Cache and return
            if (!globals.getDisableCache()) {
                await writeCache(
                    url,
                    requestOptions.headers || {},
                    createResponse(data),
                    reportErrors,
                    effectiveSignal
                );
            }
            if (isCancelled()) return null;
            return createResponse(data);
        }
    }
};

export default makeRequest;
