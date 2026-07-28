import chalk from "chalk";
import { ProxyAgent, Socks5ProxyAgent, type Dispatcher } from "undici";
import puppeteer from "./puppeteerInstance.js";
import { getChromiumPath } from "./getChromiumPath.js";
import * as globals from "./globals.js";
import { get } from "../proxy/genReq.js";
import { parseProxyUrl } from "../proxy/genericProxy.js";
import { buildOxylabsProxyUrl, composeOxylabsUsername } from "../proxy/oxylabsProxy.js";
import type { ResolvedProxyConfig } from "../proxy/resolveProxyConfig.js";
import fs from "fs";
import { EventEmitter } from "events";
import { progressError, progressLog } from "./progressLog.js";

/**
 * Proxy-wiring layer. This is the single place a resolved proxy config (see
 * `../proxy/resolveProxyConfig.ts`) is turned into an actual dispatcher/launch args — every
 * request-issuing call site (Puppeteer launches here and in `lazyLoad/`) imports these helpers
 * rather than re-deriving proxy semantics itself.
 */

/** Reconstructs a ResolvedProxyConfig from the current proxy-related globals. */
export const getResolvedProxyConfigFromGlobals = (): ResolvedProxyConfig => {
    return {
        method: globals.proxyMethod,
        url: globals.proxyUrl,
        oxylabs: globals.oxylabsConfig,
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

const reportedFailures = new Set<string>();

const reportFailure = (url: string, err: unknown): void => {
    if (reportedFailures.has(url)) return;
    reportedFailures.add(url);
    if (globals.getCacheOnly()) {
        progressError(chalk.dim(`[!] Cache miss (cache-only mode): ${url}`));
        return;
    }
    progressError(chalk.red(`[!] Failed to fetch ${url} : ${err}`));
    progressLog(chalk.dim("[i] Often, using -k flag (ignore SSL errors) fixes the problem"));
};

// random user agents
const UAs = [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
];

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

        let headersMatch = true;

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
 * Stores response body, status, and headers in cache file, handling special
 * cases like RSC (React Server Components) headers separately.
 *
 * @param url - The URL to cache the response for
 * @param headers - Request headers that were used
 * @param response - The Response object to cache
 * @returns Promise that resolves when caching is complete
 */
const writeCache = async (url: string, headers: {}, response: Response): Promise<void> => {
    try {
        await writeCacheUnsafe(url, headers, response);
    } catch (err) {
        // Caching must never break a request. Log and move on.
        progressError(chalk.yellow(`[!] Failed to write response cache for ${url}: ${err?.message || err}`));
    }
};

const writeCacheUnsafe = async (url: string, headers: {}, response: Response): Promise<void> => {
    // clone the response
    const clonedResponse = response.clone();

    // if cache exists, return
    if ((await readCache(url, headers)) !== null) {
        // console.log("cache already exists for ", url);
        return;
    }

    // open the cache file, and write the response based on the special headers
    let cache: Record<string, any>;
    try {
        cache = JSON.parse(fs.readFileSync(globals.getRespCacheFile(), "utf-8"));
    } catch {
        cache = {};
    }
    if (!cache[url]) {
        cache[url] = {};
    }

    const bodyBuffer = Buffer.from(await clonedResponse.arrayBuffer());
    const body = bodyBuffer.toString("base64");
    const status = clonedResponse.status;
    // Headers instances have no own enumerable properties — JSON.stringify(headers)
    // silently serializes to "{}", discarding every response header (including
    // Content-Type) on the next cache read. Convert to a plain object first.
    const resp_headers = Object.fromEntries(clonedResponse.headers.entries());
    if (headers["RSC"]) {
        cache[url].rsc = {
            req_headers: headers,
            status: status,
            body_b64: body,
            resp_headers: resp_headers,
        };
        // console.log("rsc", url);
    } else {
        cache[url].normal = {
            req_headers: headers,
            status: status,
            body_b64: body,
            resp_headers: resp_headers,
        };
        // console.log("normal", url);
    }
    let serialized: string;
    try {
        // so, the cache is the response body for the URL
        serialized = JSON.stringify(cache);
    } catch (err) {
        if (err instanceof RangeError) {
            // console.log(
            //     chalk.yellow(
            //         `[!] Response cache too large to serialize; dropping entry for ${url} and skipping cache write`
            //     )
            // );
            // // Roll back the entry we just added so future writes don't keep retrying.
            // if (headers["RSC"]) {
            //     delete cache[url].rsc;
            // } else {
            //     delete cache[url].normal;
            // }
            // if (!cache[url].rsc && !cache[url].normal) {
            //     delete cache[url];
            // }
            // return;

            progressError(chalk.yellow(`[!] Cache too big... Emptying cache`));
            serialized = JSON.stringify({}); // empty cache
        }
        // throw err;
    }
    fs.writeFileSync(globals.getRespCacheFile(), serialized);
    // console.log("wrote cache for ", url);
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
    requestTimeout: number
): Promise<Response | null> => {
    let res: Response;
    let counter = 0;

    while (true) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), requestTimeout);
        const currentRequestOptions = withProxyDispatcher({
            ...requestOptions,
            signal: controller.signal,
        });

        try {
            EventEmitter.defaultMaxListeners = 20;
            res = await fetch(url, currentRequestOptions);
            clearTimeout(timeoutId);
            if (res) {
                break;
            }
        } catch (err) {
            clearTimeout(timeoutId);
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
                progressError(chalk.red(`[!] Request to ${url} timed out after ${requestTimeout}ms`));
                return null;
            }
            if (counter > 10) {
                reportFailure(url, err);
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
const handleFirewall = async (url: string, resp_text: string): Promise<string | null> => {
    if (resp_text.includes("/?bm-verify=") || resp_text.includes("<title>Just a moment...</title>")) {
        progressError(chalk.yellow(`[!] CF Firewall detected. Trying to bypass with headless browser`));
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
        });
        const page = await browser.newPage();
        if (proxyArgs.authenticate) {
            await page.authenticate(proxyArgs.authenticate);
        }
        await page.goto(url);
        await new Promise((resolve) => setTimeout(resolve, 5000));
        const content = await page.content();
        await browser.close();
        return content;
    } else if (resp_text.includes("403 ERROR") && resp_text.includes("Generated by cloudfront")) {
        progressError(chalk.yellow(`[!] Cloudfront Firewall detected. Trying to bypass with headless browser`));
        const chromiumPath2 = getChromiumPath();
        const proxyArgs = buildPuppeteerProxyArgs(getResolvedProxyConfigFromGlobals());
        const browser = await puppeteer.launch({
            headless: true,
            executablePath: chromiumPath2,
            args: [
                ...(globals.getDisableSandbox()
                    ? ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
                    : []),
                ...(proxyArgs.arg ? [proxyArgs.arg] : []),
            ],
        });
        const page = await browser.newPage();
        if (proxyArgs.authenticate) {
            await page.authenticate(proxyArgs.authenticate);
        }
        await page.goto(url);
        await new Promise((resolve) => setTimeout(resolve, 5000));
        const content = await page.content();
        await browser.close();
        return content;
    }
    return null;
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
    args?: Omit<RequestInit, "timeout"> & { timeout?: number }
): Promise<Response | null> => {
    if (url.startsWith("//")) {
        url = "https:" + url;
    }
    const { timeout, ...restArgs } = args || {};
    const requestOptions: RequestInit = restArgs;
    const requestTimeout = timeout || globals.getRequestTimeout();
    const usingDefaultHeaders = !requestOptions.headers;

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
        return null;
    }
    if (!requestOptions.headers) {
        requestOptions.headers = {
            ...baseHeaders,
            Referer: parsedOrigin,
            Origin: parsedOrigin,
        };
    }

    // if cache is enabled, read the cache and return if cache is present. else, continue
    if (!globals.getDisableCache()) {
        const cachedResponse = await readCache(url, requestOptions.headers || {});

        // if the response if cached, then check if contains any signatures of firewall
        if (cachedResponse !== null) {
            const cachedText = await cachedResponse.clone().text();
            const firewallContent = await handleFirewall(url, cachedText);
            if (firewallContent) {
                await writeCache(url, requestOptions.headers || {}, new Response(firewallContent));
                return new Response(firewallContent);
            }
            return cachedResponse;
        }
    }

    if (globals.getCacheOnly()) {
        reportFailure(url, "cache miss in cache-only mode");
        return null;
    }

    if (globals.useProxy && globals.proxyMethod === "aws") {
        const get_headers = requestOptions.headers;

        const body = await get(url, get_headers);

        // craft a Response, and return that
        const response = new Response(body);

        // if cache is enabled, write the response to the cache
        if (!globals.getDisableCache()) {
            await writeCache(url, get_headers, response);
        }
        return response;
    } else {
        // Helper to read response once and store data for reuse.
        // We copy the bytes into a Buffer that owns its own ArrayBuffer so the
        // stored body cannot be invalidated by undici recycling its internal
        // buffer after we consume the response.
        const consumeResponse = async (
            res: Response | null
        ): Promise<{ body: Buffer; status: number; headers: Headers; ok: boolean; text: string } | null> => {
            if (!res) return null;
            const ab = await res.arrayBuffer();
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
                requestTimeout
            );
            const dataWithReferer = await consumeResponse(resWithReferer);

            if (dataWithReferer && dataWithReferer.ok) {
                // Check for firewall
                const firewallContent = await handleFirewall(url, dataWithReferer.text);
                if (firewallContent) {
                    if (!globals.getDisableCache()) {
                        await writeCache(url, headersWithReferer, new Response(firewallContent));
                    }
                    return new Response(firewallContent);
                }

                // Cache and return successful response
                if (!globals.getDisableCache()) {
                    await writeCache(url, headersWithReferer, createResponse(dataWithReferer));
                }
                return createResponse(dataWithReferer);
            }

            // Second try: without Referer and Origin
            const headersWithoutReferer = { ...baseHeaders };
            const resWithoutReferer = await singleFetch(
                url,
                { ...requestOptions, headers: headersWithoutReferer },
                requestTimeout
            );
            const dataWithoutReferer = await consumeResponse(resWithoutReferer);

            if (dataWithoutReferer && dataWithoutReferer.ok) {
                // Check for firewall
                const firewallContent = await handleFirewall(url, dataWithoutReferer.text);
                if (firewallContent) {
                    if (!globals.getDisableCache()) {
                        await writeCache(url, headersWithoutReferer, new Response(firewallContent));
                    }
                    return new Response(firewallContent);
                }

                // Cache and return successful response
                if (!globals.getDisableCache()) {
                    await writeCache(url, headersWithoutReferer, createResponse(dataWithoutReferer));
                }
                return createResponse(dataWithoutReferer);
            }

            // Both failed, return whichever response we got (prefer non-null)
            const finalData = dataWithReferer || dataWithoutReferer;
            if (finalData) {
                if (!globals.getDisableCache()) {
                    await writeCache(url, headersWithReferer, createResponse(finalData));
                }
                return createResponse(finalData);
            }
            return null;
        } else {
            // Custom headers provided, use them directly
            const res = await singleFetch(url, requestOptions, requestTimeout);
            const data = await consumeResponse(res);
            if (!data) return null;

            // Check for firewall
            const firewallContent = await handleFirewall(url, data.text);
            if (firewallContent) {
                if (!globals.getDisableCache()) {
                    await writeCache(url, requestOptions.headers || {}, new Response(firewallContent));
                }
                return new Response(firewallContent);
            }

            // Cache and return
            if (!globals.getDisableCache()) {
                await writeCache(url, requestOptions.headers || {}, createResponse(data));
            }
            return createResponse(data);
        }
    }
};

export default makeRequest;
