import chalk from "chalk";
import { ProxyAgent, Socks5ProxyAgent, type Dispatcher } from "undici";
import puppeteer from "./puppeteerInstance.js";
import { getChromiumPath } from "./getChromiumPath.js";
import * as globals from "./globals.js";
import { getWithMetadata } from "../proxy/genReq.js";
import checkFireWallBlocking from "../proxy/checkFireWallBlocking.js";
import { parseProxyUrl } from "../proxy/genericProxy.js";
import { buildOxylabsProxyUrl, composeOxylabsUsername } from "../proxy/oxylabsProxy.js";
import type { ResolvedProxyConfig } from "../proxy/resolveProxyConfig.js";
import { EventEmitter } from "events";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { progressError, progressLog } from "./progressLog.js";
import { isSigintHandlerActive } from "../run/interruptHandler.js";
import detectBlockedResponse from "../proxy/detectBlockedResponse.js";
import { claimOxylabsFallback, getOxylabsFallbackConfiguration } from "../proxy/oxylabsFallback.js";
import { deleteCacheEntry, readCacheEntry, writeCacheEntryUnsafe } from "./cacheDb.js";

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

/**
 * Runs request work with an owned dispatcher and always releases its sockets.
 * The callback must consume response bodies before returning.
 */
export const withManagedDispatcher = async <T>(
    dispatcher: Dispatcher | null,
    work: (options: FetchOptsWithDispatcher) => Promise<T>
): Promise<T> => {
    if (!dispatcher) return await work({});

    let completed = false;
    try {
        const result = await work({ dispatcher });
        completed = true;
        return result;
    } finally {
        const cleanup = completed ? dispatcher.close() : dispatcher.destroy();
        await cleanup.catch(() => undefined);
    }
};

/** Runs request work through the globally active proxy, when proxy use is enabled. */
export const withActiveProxyDispatcher = async <T>(
    work: (options: FetchOptsWithDispatcher) => Promise<T>
): Promise<T> => {
    const dispatcher = globals.getUseProxy() ? buildUndiciDispatcher(getResolvedProxyConfigFromGlobals()) : null;
    return await withManagedDispatcher(dispatcher, work);
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

/** Returns browser proxy arguments only when proxy routing is currently enabled. */
export const getActivePuppeteerProxyArgs = (): PuppeteerProxyArgs =>
    globals.getUseProxy() ? buildPuppeteerProxyArgs(getResolvedProxyConfigFromGlobals()) : { arg: null };

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

export const getCacheIdentityDigest = (url: string, headers: HeadersInit): string => {
    const normalizedHeaders = [...new Headers(headers as HeadersInit).entries()].sort(([left], [right]) =>
        left.localeCompare(right)
    );
    return createHash("sha256")
        .update(JSON.stringify([url, normalizedHeaders]))
        .digest("hex");
};

/**
 * Reads response data from the SQLite response cache for future requests.
 *
 * Looks up the given URL/headers identity digest in `cache_entries`. If a row
 * is found, builds a Response object with the cached data and returns it.
 * Returns null on a miss (including a miss caused by the digest belonging to
 * a different target, which is the normal/expected case, not an error).
 *
 * @param url - The URL to read the cache for
 * @param headers - Request headers that were used
 * @returns A Promise that resolves to a Response object if the cache is found, or null if not
 */
const readCache = async (url: string, headers: HeadersInit): Promise<Response | null> => {
    const identityDigest = getCacheIdentityDigest(url, headers);
    try {
        const entry = readCacheEntry(identityDigest);
        if (entry) {
            return new Response(Buffer.from(entry.bodyBase64, "base64"), {
                status: entry.status,
                statusText: entry.statusText,
                headers: entry.responseHeaders,
            });
        }
    } catch {
        // Corrupt/unreadable cache DB — treat as a cache miss, never break the request.
    }
    return null;
};

/**
 * Writes response data to the SQLite response cache for future requests.
 *
 * Stores one row per URL/request-header identity digest, first-write-wins for
 * a duplicate digest (see `cacheDb.ts`'s `writeCacheEntryUnsafe`).
 *
 * @param url - The URL to cache the response for
 * @param headers - Request headers that were used
 * @param response - The Response object to cache
 * @returns Promise that resolves when caching is complete
 */
const writeCache = async (
    url: string,
    headers: HeadersInit,
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

const writeCacheUnsafe = async (
    url: string,
    headers: HeadersInit,
    response: Response,
    signal?: AbortSignal
): Promise<void> => {
    if (signal?.aborted) return;
    const identityDigest = getCacheIdentityDigest(url, headers);

    const clonedResponse = response.clone();
    const bodyBuffer = Buffer.from(await clonedResponse.arrayBuffer());
    if (signal?.aborted) return;
    writeCacheEntryUnsafe({
        identityDigest,
        url,
        status: clonedResponse.status,
        statusText: clonedResponse.statusText,
        bodyBase64: bodyBuffer.toString("base64"),
        responseHeaders: Object.freeze(Object.fromEntries(clonedResponse.headers.entries())),
    });
};

/**
 * Performs a single fetch request with retry logic.
 *
 * @param url - The URL to request
 * @param requestOptions - Request options including headers
 * @param requestTimeout - Timeout in milliseconds
 * @returns A fully buffered response, or null if all retries fail
 */
interface BufferedResponse {
    readonly body: Buffer;
    readonly status: number;
    readonly headers: Headers;
    readonly ok: boolean;
    readonly text: string;
}

const singleFetch = async (
    url: string,
    requestOptions: RequestInit,
    requestTimeout: number,
    reportErrors: boolean = true,
    dispatcherOverride?: Dispatcher,
    maxAttempts: number = 11
): Promise<BufferedResponse | null> => {
    let counter = 0;
    let shouldDestroyOwnedDispatcher = false;
    const ownedDispatcher =
        dispatcherOverride || !globals.getUseProxy()
            ? null
            : buildUndiciDispatcher(getResolvedProxyConfigFromGlobals());
    const dispatcher = dispatcherOverride ?? ownedDispatcher ?? undefined;

    try {
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
                shouldDestroyOwnedDispatcher = true;
                controller.abort();
                clearTimeout(timeoutId);
                return null;
            } else {
                upstreamSignal?.addEventListener("abort", abortFromUpstream, { once: true });
            }
            const currentRequestOptions: FetchOptsWithDispatcher = {
                ...requestOptions,
                signal: controller.signal,
                ...(dispatcher ? { dispatcher } : {}),
            };

            try {
                EventEmitter.defaultMaxListeners = 20;
                const response = await fetch(url, currentRequestOptions); // lgtm[js/insecure-download]: this is a recon tool's generic HTTP client — it fetches whatever URL/scheme the target itself serves, by design.
                const arrayBuffer = await response.arrayBuffer();
                if (controller.signal.aborted) {
                    shouldDestroyOwnedDispatcher = true;
                    return null;
                }
                const body = Buffer.alloc(arrayBuffer.byteLength);
                body.set(new Uint8Array(arrayBuffer));
                return {
                    body,
                    status: response.status,
                    headers: new Headers(response.headers),
                    ok: response.ok,
                    text: body.toString("utf-8"),
                };
            } catch (err) {
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
                    shouldDestroyOwnedDispatcher = true;
                    if (reportErrors && (timedOut || !upstreamSignal?.aborted)) reportTimeout(url, requestTimeout);
                    return null;
                }
                if (counter >= maxAttempts) {
                    shouldDestroyOwnedDispatcher = true;
                    if (reportErrors) reportFailure(url, err);
                    return null;
                }
                await new Promise((resolve) => setTimeout(resolve, 500));
            } finally {
                clearTimeout(timeoutId);
                upstreamSignal?.removeEventListener("abort", abortFromUpstream);
            }
        }
    } finally {
        if (ownedDispatcher) {
            const cleanup =
                shouldDestroyOwnedDispatcher || requestOptions.signal?.aborted
                    ? ownedDispatcher.destroy()
                    : ownedDispatcher.close();
            await cleanup.catch(() => undefined);
        }
    }
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
    responseMetadata?: Readonly<{ status: number; headers: Headers }>,
    signal?: AbortSignal,
    reportErrors: boolean = true
): Promise<string | null> => {
    const detection = detectBlockedResponse({
        status: responseMetadata?.status ?? 200,
        headers: responseMetadata?.headers,
        body: responseText,
    });
    if (!detection.blocked || signal?.aborted) return null;
    const firewall = detection.provider === "cloudfront" ? "CloudFront" : "Cloudflare/CDN";

    if (reportErrors) {
        progressError(chalk.yellow(`[!] ${firewall} Firewall detected. Trying to bypass with headless browser`));
    }
    const chromiumPath = getChromiumPath();
    const proxyArgs = getActivePuppeteerProxyArgs();
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
    const requestStartedWithProxy = globals.getUseProxy();

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
            const cachedDetection = detectBlockedResponse({
                status: cachedEntry.response.status,
                headers: cachedEntry.response.headers,
                body: cachedText,
            });
            const shouldRefreshBlockedCache =
                !globals.getCacheOnly() &&
                !requestStartedWithProxy &&
                getOxylabsFallbackConfiguration().enabled &&
                cachedDetection.blocked;
            if (shouldRefreshBlockedCache) {
                const identityDigest = getCacheIdentityDigest(url, cachedEntry.headers);
                try {
                    deleteCacheEntry(identityDigest);
                } catch (error) {
                    if (reportErrors) {
                        progressError(chalk.yellow(`[!] Could not replace blocked cache entry for ${url}: ${error}`));
                    }
                }
            } else {
                if (globals.getCacheOnly()) return cachedEntry.response;
                const firewallContent = await handleFirewall(
                    url,
                    cachedText,
                    { status: cachedEntry.response.status, headers: cachedEntry.response.headers },
                    effectiveSignal,
                    reportErrors
                );
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
    }

    if (globals.getCacheOnly()) {
        if (reportErrors) reportFailure(url, "cache miss in cache-only mode");
        return null;
    }

    if (globals.getUseProxy() && globals.getProxyMethod() === "aws") {
        const getHeaders = Object.fromEntries(new Headers(requestOptions.headers).entries());

        let awsResponse: Awaited<ReturnType<typeof getWithMetadata>>;
        try {
            awsResponse = await getWithMetadata(url, getHeaders, effectiveSignal);
        } catch (err) {
            if (isCancelled()) return null;
            if (reportErrors) reportFailure(url, err);
            return null;
        }
        if (isCancelled()) return null;

        // check if any firewall is there in the way
        if (
            await checkFireWallBlocking(awsResponse.body, { status: awsResponse.status, headers: awsResponse.headers })
        ) {
            progressError(chalk.magenta("[!] Please try again without API Gateway"));
            process.exit(18);
        }

        // craft a Response, and return that
        const response = new Response(awsResponse.body, {
            status: awsResponse.status ?? 200,
            headers: awsResponse.headers ?? {},
        });

        // if cache is enabled, write the response to the cache
        if (!globals.getDisableCache()) {
            await writeCache(url, getHeaders, response, reportErrors, effectiveSignal);
        }
        if (isCancelled()) return null;
        return response;
    } else {
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

        let oxylabsFallbackAttempted = false;
        const maybeRetryBlockedResponse = async (
            directData: BufferedResponse | null,
            headers: HeadersInit
        ): Promise<BufferedResponse | null> => {
            if (!directData || isCancelled()) return null;
            if (!getOxylabsFallbackConfiguration().enabled) return null;
            const detection = detectBlockedResponse({
                status: directData.status,
                headers: directData.headers,
                body: directData.text,
            });
            if (!detection.blocked) return null;

            const method = (requestOptions.method ?? "GET").toUpperCase();
            if (requestStartedWithProxy || oxylabsFallbackAttempted || !["GET", "HEAD"].includes(method)) {
                return null;
            }
            oxylabsFallbackAttempted = true;
            const proxy = claimOxylabsFallback(url);
            if (!proxy || isCancelled()) return null;

            if (reportErrors) {
                progressLog(
                    chalk.yellow(
                        `[i] ${detection.provider ?? "CDN/WAF"} block detected; retrying this request through Oxylabs`
                    )
                );
            }
            const dispatcher = buildUndiciDispatcher({ method: "oxylabs", oxylabs: proxy });
            if (!dispatcher) return null;

            let fallbackData: BufferedResponse | null = null;
            try {
                fallbackData = await singleFetch(
                    url,
                    { ...requestOptions, headers },
                    requestTimeout,
                    false,
                    dispatcher,
                    1
                );
            } finally {
                const cleanup = isCancelled() || !fallbackData ? dispatcher.destroy() : dispatcher.close();
                await cleanup.catch(() => undefined);
            }
            if (!fallbackData || isCancelled()) return null;

            const fallbackDetection = detectBlockedResponse({
                status: fallbackData.status,
                headers: fallbackData.headers,
                body: fallbackData.text,
            });
            if (fallbackDetection.blocked || !fallbackData.ok) {
                if (reportErrors) {
                    progressError(chalk.yellow("[!] Oxylabs fallback did not bypass the CDN/WAF response"));
                }
                return null;
            }
            return fallbackData;
        };

        const finishPlainResponse = async (
            data: BufferedResponse | null,
            headers: HeadersInit
        ): Promise<Response | null> => {
            if (!data?.ok) return null;
            const detection = detectBlockedResponse({
                status: data.status,
                headers: data.headers,
                body: data.text,
            });
            if (detection.blocked) return null;

            if (!globals.getDisableCache()) {
                await writeCache(url, headers, createResponse(data), reportErrors, effectiveSignal);
            }
            return isCancelled() ? null : createResponse(data);
        };

        const tryBrowserRecovery = async (
            blockedData: BufferedResponse | null,
            headers: HeadersInit
        ): Promise<Response | null> => {
            if (!blockedData?.ok || isCancelled()) return null;
            let browserContent: string | null;
            try {
                browserContent = await handleFirewall(
                    url,
                    blockedData.text,
                    { status: blockedData.status, headers: blockedData.headers },
                    effectiveSignal,
                    reportErrors
                );
            } catch (error) {
                if (reportErrors && !isCancelled()) {
                    progressError(
                        chalk.yellow(`[!] Browser firewall bypass failed for ${url}: ${error?.message || error}`)
                    );
                }
                return null;
            }
            if (!browserContent || isCancelled()) return null;

            const browserDetection = detectBlockedResponse({
                status: 200,
                headers: { "content-type": "text/html" },
                body: browserContent,
            });
            if (browserDetection.blocked) {
                if (reportErrors) {
                    progressError(chalk.yellow("[!] Browser fallback still returned a CDN/WAF challenge"));
                }
                return null;
            }

            const response = new Response(browserContent);
            if (!globals.getDisableCache()) {
                await writeCache(url, headers, response, reportErrors, effectiveSignal);
            }
            return isCancelled() ? null : new Response(browserContent);
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
            const directDataWithReferer = await singleFetch(
                url,
                { ...requestOptions, headers: headersWithReferer },
                requestTimeout,
                false
            );
            if (isCancelled()) return null;
            const withRefererResponse = await finishPlainResponse(directDataWithReferer, headersWithReferer);
            if (withRefererResponse) return withRefererResponse;

            // Second try: without Referer and Origin
            const headersWithoutReferer = { ...baseHeaders };
            const directDataWithoutReferer = await singleFetch(
                url,
                { ...requestOptions, headers: headersWithoutReferer },
                requestTimeout,
                reportErrors && !directDataWithReferer
            );
            if (isCancelled()) return null;
            const withoutRefererResponse = await finishPlainResponse(directDataWithoutReferer, headersWithoutReferer);
            if (withoutRefererResponse) return withoutRefererResponse;

            const candidates = [
                { data: directDataWithoutReferer, headers: headersWithoutReferer },
                { data: directDataWithReferer, headers: headersWithReferer },
            ];
            const blockedCandidate = candidates.find(
                ({ data }) =>
                    data &&
                    detectBlockedResponse({ status: data.status, headers: data.headers, body: data.text }).blocked
            );
            if (blockedCandidate) {
                const fallbackData = await maybeRetryBlockedResponse(blockedCandidate.data, blockedCandidate.headers);
                if (isCancelled()) return null;
                const fallbackResponse = await finishPlainResponse(fallbackData, blockedCandidate.headers);
                if (fallbackResponse) return fallbackResponse;

                const browserResponse = await tryBrowserRecovery(blockedCandidate.data, blockedCandidate.headers);
                if (browserResponse) return browserResponse;
            }

            // Prefer the most recent non-blocked response, then any direct response.
            const finalCandidate =
                candidates.find(
                    ({ data }) =>
                        data &&
                        !detectBlockedResponse({ status: data.status, headers: data.headers, body: data.text }).blocked
                ) ?? candidates.find(({ data }) => data !== null);
            if (finalCandidate?.data) {
                const finalData = finalCandidate.data;
                const finalDetection = detectBlockedResponse({
                    status: finalData.status,
                    headers: finalData.headers,
                    body: finalData.text,
                });
                if (!globals.getDisableCache() && !finalDetection.blocked) {
                    await writeCache(
                        url,
                        finalCandidate.headers,
                        createResponse(finalData),
                        reportErrors,
                        effectiveSignal
                    );
                }
                if (isCancelled()) return null;
                return createResponse(finalData);
            }
            return null;
        } else {
            // Custom headers provided, use them directly
            const directData = await singleFetch(url, requestOptions, requestTimeout, reportErrors);
            if (!directData || isCancelled()) return null;
            const directResponse = await finishPlainResponse(directData, requestOptions.headers || {});
            if (directResponse) return directResponse;

            const fallbackData = await maybeRetryBlockedResponse(directData, requestOptions.headers || {});
            if (isCancelled()) return null;
            const fallbackResponse = await finishPlainResponse(fallbackData, requestOptions.headers || {});
            if (fallbackResponse) return fallbackResponse;

            const browserResponse = await tryBrowserRecovery(directData, requestOptions.headers || {});
            if (browserResponse) return browserResponse;

            const directDetection = detectBlockedResponse({
                status: directData.status,
                headers: directData.headers,
                body: directData.text,
            });
            if (!globals.getDisableCache() && !directDetection.blocked) {
                await writeCache(
                    url,
                    requestOptions.headers || {},
                    createResponse(directData),
                    reportErrors,
                    effectiveSignal
                );
            }
            if (isCancelled()) return null;
            return createResponse(directData);
        }
    }
};

export default makeRequest;
