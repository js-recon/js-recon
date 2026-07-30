import fs from "fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import makeRequest, { getActivePuppeteerProxyArgs, withRequestSignal } from "../../utility/makeReq.js";
import {
    setCacheOnly,
    setDisableCache,
    setOxylabsConfig,
    setProxyMethod,
    setRespCacheFile,
    setUseProxy,
} from "../../utility/globals.js";
import puppeteer from "../../utility/puppeteerInstance.js";
import { configureOxylabsFallback, resetOxylabsFallback } from "../../proxy/oxylabsFallback.js";

const requestHarness = vi.hoisted(() => ({
    awsGet: vi.fn(),
}));

let temporaryCacheDirectory: string | undefined;

vi.mock("../../proxy/genReq.js", () => ({
    get: requestHarness.awsGet,
}));

beforeEach(() => {
    setDisableCache(true);
    setCacheOnly(false);
    setUseProxy(false);
    setProxyMethod(null);
    setOxylabsConfig(undefined);
    resetOxylabsFallback();
    requestHarness.awsGet.mockReset();
});

afterEach(() => {
    setDisableCache(false);
    setUseProxy(false);
    setProxyMethod(null);
    setOxylabsConfig(undefined);
    resetOxylabsFallback();
    setRespCacheFile(".resp_cache.json");
    if (temporaryCacheDirectory) {
        fs.rmSync(temporaryCacheDirectory, { recursive: true, force: true });
        temporaryCacheDirectory = undefined;
    }
    vi.restoreAllMocks();
});

describe("makeRequest error reporting ownership", () => {
    it("preserves the direct fallback flow when Oxylabs fallback is disabled", async () => {
        const fetchSpy = vi
            .spyOn(globalThis, "fetch")
            .mockResolvedValueOnce(
                new Response("<title>Access denied</title><body>Request blocked</body>", {
                    status: 403,
                    headers: { server: "cloudflare", "cf-ray": "test-ray", "content-type": "text/html" },
                })
            )
            .mockResolvedValueOnce(new Response("const directRecovery = true;", { status: 200 }));

        const response = await makeRequest("https://disabled-fallback.example.test/chunk.js", {
            reportErrors: false,
        });

        await expect(response?.text()).resolves.toBe("const directRecovery = true;");
        expect(fetchSpy).toHaveBeenCalledTimes(2);
        for (const [, options] of fetchSpy.mock.calls) expect(options).not.toHaveProperty("dispatcher");
    });

    it("retries a strongly identified Cloudflare block once through Oxylabs", async () => {
        configureOxylabsFallback({
            enabled: true,
            maxRequestsPerOrigin: 10,
            proxy: { username: "operator", password: "secret", country: "us" },
        });
        const fetchSpy = vi
            .spyOn(globalThis, "fetch")
            .mockResolvedValueOnce(
                new Response("<title>Just a moment...</title>", {
                    status: 403,
                    headers: { server: "cloudflare", "cf-ray": "test-ray", "content-type": "text/html" },
                })
            )
            .mockResolvedValueOnce(
                new Response("<title>Just a moment...</title>", {
                    status: 403,
                    headers: { server: "cloudflare", "cf-ray": "test-ray-2", "content-type": "text/html" },
                })
            )
            .mockResolvedValueOnce(
                new Response("const recovered = true;", {
                    status: 200,
                    headers: { "content-type": "application/javascript" },
                })
            );

        const response = await makeRequest("https://cdn.example.test/chunk.js", { reportErrors: false });

        await expect(response?.text()).resolves.toBe("const recovered = true;");
        expect(fetchSpy).toHaveBeenCalledTimes(3);
        expect(fetchSpy.mock.calls[0][1]).not.toHaveProperty("dispatcher");
        expect(fetchSpy.mock.calls[1][1]).not.toHaveProperty("dispatcher");
        expect(fetchSpy.mock.calls[2][1]).toHaveProperty("dispatcher");
    });

    it("exhausts the free no-Referer strategy before spending an Oxylabs request", async () => {
        configureOxylabsFallback({
            enabled: true,
            maxRequestsPerOrigin: 10,
            proxy: { username: "operator", password: "secret" },
        });
        const fetchSpy = vi
            .spyOn(globalThis, "fetch")
            .mockResolvedValueOnce(
                new Response("<title>Just a moment...</title>", {
                    status: 403,
                    headers: { server: "cloudflare", "cf-ray": "test-ray", "content-type": "text/html" },
                })
            )
            .mockResolvedValueOnce(new Response("const directRecovery = true;", { status: 200 }));

        const response = await makeRequest("https://free-recovery.example.test/chunk.js", { reportErrors: false });

        await expect(response?.text()).resolves.toBe("const directRecovery = true;");
        expect(fetchSpy).toHaveBeenCalledTimes(2);
        for (const [, options] of fetchSpy.mock.calls) expect(options).not.toHaveProperty("dispatcher");
    });

    it("evaluates both plain direct variants and Oxylabs before browser recovery", async () => {
        configureOxylabsFallback({
            enabled: true,
            maxRequestsPerOrigin: 10,
            proxy: { username: "operator", password: "secret" },
        });
        const browserSpy = vi.spyOn(puppeteer, "launch").mockRejectedValue(new Error("browser should not launch"));
        const challenge = () =>
            new Response("<!doctype html><title>Just a moment...</title>", {
                status: 200,
                headers: { server: "cloudflare", "cf-ray": "challenge-ray", "content-type": "text/html" },
            });
        const fetchSpy = vi
            .spyOn(globalThis, "fetch")
            .mockResolvedValueOnce(challenge())
            .mockResolvedValueOnce(challenge())
            .mockResolvedValueOnce(new Response("const paidRecovery = true;", { status: 200 }));

        const response = await makeRequest("https://challenge.example.test/chunk.js", { reportErrors: false });

        await expect(response?.text()).resolves.toBe("const paidRecovery = true;");
        expect(fetchSpy).toHaveBeenCalledTimes(3);
        expect(fetchSpy.mock.calls[2][1]).toHaveProperty("dispatcher");
        expect(browserSpy).not.toHaveBeenCalled();
    });

    it("does not spend Oxylabs requests on ordinary HTML or missing chunks", async () => {
        configureOxylabsFallback({
            enabled: true,
            maxRequestsPerOrigin: 10,
            proxy: { username: "operator", password: "secret" },
        });
        const fetchSpy = vi
            .spyOn(globalThis, "fetch")
            .mockResolvedValueOnce(new Response("<!doctype html><title>Application</title>", { status: 200 }))
            .mockImplementation(async () => new Response("not found", { status: 404 }));

        await expect(
            makeRequest("https://app.example.test/spa-fallback.js", { reportErrors: false })
        ).resolves.toBeInstanceOf(Response);
        await expect(
            makeRequest("https://app.example.test/missing.js", { reportErrors: false })
        ).resolves.toBeInstanceOf(Response);

        expect(fetchSpy).toHaveBeenCalledTimes(3);
        for (const [, options] of fetchSpy.mock.calls) expect(options).not.toHaveProperty("dispatcher");
    });

    it("makes only one paid request after both direct variants are blocked", async () => {
        configureOxylabsFallback({
            enabled: true,
            maxRequestsPerOrigin: 10,
            proxy: { username: "operator", password: "secret" },
        });
        const blocked = () =>
            new Response("<title>Just a moment...</title>", {
                status: 403,
                headers: { server: "cloudflare", "cf-ray": "test-ray" },
            });
        const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => blocked());

        const response = await makeRequest("https://blocked.example.test/chunk.js", { reportErrors: false });

        expect(response?.status).toBe(403);
        expect(fetchSpy).toHaveBeenCalledTimes(3);
        expect(fetchSpy.mock.calls[0][1]).not.toHaveProperty("dispatcher");
        expect(fetchSpy.mock.calls[1][1]).not.toHaveProperty("dispatcher");
        expect(fetchSpy.mock.calls[2][1]).toHaveProperty("dispatcher");
    });

    it("caches a successful Oxylabs recovery under the direct request identity", async () => {
        setDisableCache(false);
        temporaryCacheDirectory = fs.mkdtempSync("/tmp/js-recon-oxylabs-cache-");
        const cachePath = `${temporaryCacheDirectory}/responses.json`;
        fs.writeFileSync(cachePath, "{}");
        setRespCacheFile(cachePath);
        configureOxylabsFallback({
            enabled: true,
            maxRequestsPerOrigin: 10,
            proxy: { username: "operator", password: "secret" },
        });
        const fetchSpy = vi
            .spyOn(globalThis, "fetch")
            .mockResolvedValueOnce(
                new Response("<title>Just a moment...</title>", {
                    status: 403,
                    headers: { server: "cloudflare", "cf-ray": "test-ray" },
                })
            )
            .mockResolvedValueOnce(
                new Response("<title>Just a moment...</title>", {
                    status: 403,
                    headers: { server: "cloudflare", "cf-ray": "test-ray-2" },
                })
            )
            .mockResolvedValueOnce(new Response("const cachedRecovery = true;", { status: 200 }));

        await expect(
            makeRequest("https://cache-fallback.example.test/chunk.js", { reportErrors: false })
        ).resolves.toBeInstanceOf(Response);
        fetchSpy.mockClear();
        setCacheOnly(true);

        const cached = await makeRequest("https://cache-fallback.example.test/chunk.js", {
            reportErrors: false,
        });

        await expect(cached?.text()).resolves.toBe("const cachedRecovery = true;");
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("refreshes a legacy cached WAF block through direct-first Oxylabs fallback", async () => {
        setDisableCache(false);
        temporaryCacheDirectory = fs.mkdtempSync("/tmp/js-recon-blocked-cache-");
        const cachePath = `${temporaryCacheDirectory}/responses.json`;
        const url = "https://cached-block.example.test/chunk.js";
        fs.writeFileSync(
            cachePath,
            JSON.stringify({
                [url]: {
                    normal: {
                        status: 403,
                        body_b64: Buffer.from("<title>Just a moment...</title>").toString("base64"),
                        resp_headers: { server: "cloudflare", "cf-ray": "cached-ray" },
                    },
                },
            })
        );
        setRespCacheFile(cachePath);
        configureOxylabsFallback({
            enabled: true,
            maxRequestsPerOrigin: 10,
            proxy: { username: "operator", password: "secret" },
        });
        const fetchSpy = vi
            .spyOn(globalThis, "fetch")
            .mockResolvedValueOnce(
                new Response("<title>Just a moment...</title>", {
                    status: 403,
                    headers: { server: "cloudflare", "cf-ray": "direct-ray" },
                })
            )
            .mockResolvedValueOnce(
                new Response("<title>Just a moment...</title>", {
                    status: 403,
                    headers: { server: "cloudflare", "cf-ray": "direct-ray-2" },
                })
            )
            .mockResolvedValueOnce(new Response("const refreshed = true;", { status: 200 }));

        const response = await makeRequest(url, { reportErrors: false });

        await expect(response?.text()).resolves.toBe("const refreshed = true;");
        expect(fetchSpy).toHaveBeenCalledTimes(3);
        expect(fetchSpy.mock.calls[2][1]).toHaveProperty("dispatcher");
    });

    it("does not attach a configured dispatcher while proxy use is disabled", async () => {
        setProxyMethod("oxylabs");
        setOxylabsConfig({ username: "operator", password: "secret" });
        setUseProxy(false);
        const fetchSpy = vi
            .spyOn(globalThis, "fetch")
            .mockResolvedValue(new Response("const direct = true;", { status: 200 }));

        await makeRequest("https://direct.example.test/chunk.js", { reportErrors: false });

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(fetchSpy.mock.calls[0][1]).not.toHaveProperty("dispatcher");
        expect(getActivePuppeteerProxyArgs()).toEqual({ arg: null });

        setUseProxy(true);
        expect(getActivePuppeteerProxyArgs()).toMatchObject({
            arg: "--proxy-server=pr.oxylabs.io:7777",
            authenticate: { username: "user-operator", password: "secret" },
        });
    });

    it("reports an invalid URL when it owns diagnostics", async () => {
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

        await expect(makeRequest("not a URL", { reportErrors: true })).resolves.toBeNull();

        expect(errorSpy).toHaveBeenCalledTimes(1);
        expect(errorSpy.mock.calls.flat().join("\n")).toContain("Invalid request URL");
    });

    it("keeps invalid URL diagnostics silent when the caller owns reporting", async () => {
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

        await expect(makeRequest("still not a URL", { reportErrors: false })).resolves.toBeNull();

        expect(errorSpy).not.toHaveBeenCalled();
    });

    it("reports separate request invocations for the same URL independently", async () => {
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

        await makeRequest("repeated invalid URL", { reportErrors: true });
        await makeRequest("repeated invalid URL", { reportErrors: true });

        expect(errorSpy).toHaveBeenCalledTimes(2);
    });

    it("reports at most one timeout when both default-header attempts fail", async () => {
        const timeoutError = Object.assign(new Error("timed out"), { name: "AbortError" });
        vi.spyOn(globalThis, "fetch").mockRejectedValue(timeoutError);
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

        await expect(
            makeRequest("https://timeouts.example.test/chunk.js", { timeout: 1, reportErrors: true })
        ).resolves.toBeNull();

        expect(fetch).toHaveBeenCalledTimes(2);
        expect(errorSpy).toHaveBeenCalledTimes(1);
        expect(errorSpy.mock.calls.flat().join("\n")).toContain("timed out");
    });

    it("keeps timeout and cancellation ownership until the response body is consumed", async () => {
        const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, options) => {
            const response = new Response("unused", { status: 200 });
            vi.spyOn(response, "arrayBuffer").mockImplementation(
                () =>
                    new Promise<ArrayBuffer>((_resolve, reject) => {
                        options?.signal?.addEventListener(
                            "abort",
                            () => reject(Object.assign(new Error("body timed out"), { name: "AbortError" })),
                            { once: true }
                        );
                    })
            );
            return response;
        });

        await expect(
            makeRequest("https://slow-body.example.test/chunk.js", { timeout: 1, reportErrors: false })
        ).resolves.toBeNull();

        expect(fetchSpy).toHaveBeenCalledTimes(2);
        expect(fetchSpy.mock.calls.every(([, options]) => options?.signal instanceof AbortSignal)).toBe(true);
    });

    it("does not report a failed first header strategy when the fallback succeeds", async () => {
        const timeoutError = Object.assign(new Error("timed out"), { name: "AbortError" });
        vi.spyOn(globalThis, "fetch")
            .mockRejectedValueOnce(timeoutError)
            .mockResolvedValueOnce(new Response("const recovered = true;", { status: 200 }));
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

        const response = await makeRequest("https://fallback.example.test/chunk.js", {
            timeout: 1,
            reportErrors: true,
        });

        await expect(response?.text()).resolves.toBe("const recovered = true;");
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(errorSpy).not.toHaveBeenCalled();
    });

    it("reuses a cached no-Referer fallback in cache-only mode", async () => {
        setDisableCache(false);
        temporaryCacheDirectory = fs.mkdtempSync("/tmp/js-recon-fallback-cache-");
        const cachePath = `${temporaryCacheDirectory}/responses.json`;
        fs.writeFileSync(cachePath, "{}");
        setRespCacheFile(cachePath);
        const timeoutError = Object.assign(new Error("timed out"), { name: "AbortError" });
        const fetchSpy = vi
            .spyOn(globalThis, "fetch")
            .mockRejectedValueOnce(timeoutError)
            .mockResolvedValueOnce(new Response("const fallback = true;", { status: 200 }));

        await expect(
            makeRequest("https://fallback-cache.example.test/chunk.js", { timeout: 1, reportErrors: false })
        ).resolves.toBeInstanceOf(Response);
        fetchSpy.mockClear();
        setCacheOnly(true);

        const cached = await makeRequest("https://fallback-cache.example.test/chunk.js", {
            timeout: 1,
            reportErrors: false,
        });

        await expect(cached?.text()).resolves.toBe("const fallback = true;");
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("suppresses per-URL cache write diagnostics when the caller requests compact output", async () => {
        setDisableCache(false);
        setRespCacheFile("/tmp/js-recon-unwritable-cache.json");
        vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("const ok = true;", { status: 200 }));
        vi.spyOn(fs, "existsSync").mockReturnValue(false);
        vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
            throw new Error("read-only cache path");
        });
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

        await expect(
            makeRequest("https://cache-errors.example.test/chunk.js", { reportErrors: false })
        ).resolves.toBeInstanceOf(Response);

        expect(errorSpy).not.toHaveBeenCalled();
    });

    it("preserves every entry when concurrent requests update the response cache", async () => {
        setDisableCache(false);
        temporaryCacheDirectory = fs.mkdtempSync("/tmp/js-recon-response-cache-");
        const cachePath = `${temporaryCacheDirectory}/responses.json`;
        fs.writeFileSync(cachePath, "{}");
        setRespCacheFile(cachePath);
        const fetchSpy = vi
            .spyOn(globalThis, "fetch")
            .mockImplementation(async (url) =>
                Promise.resolve(new Response(`const source = ${JSON.stringify(String(url))};`, { status: 200 }))
            );

        await Promise.all([
            makeRequest("https://cache.example.test/a.js", { reportErrors: false }),
            makeRequest("https://cache.example.test/b.js", { reportErrors: false }),
        ]);

        const entryDirectory = `${cachePath}.entries`;
        const entryFiles = fs.readdirSync(entryDirectory).filter((name) => name.endsWith(".json"));
        expect(entryFiles).toHaveLength(2);
        const serializedEntries = entryFiles
            .map((name) => fs.readFileSync(`${entryDirectory}/${name}`, "utf8"))
            .join("\n");
        expect(serializedEntries).not.toContain("Mozilla/");

        fetchSpy.mockClear();
        await Promise.all([
            makeRequest("https://cache.example.test/a.js", { reportErrors: false }),
            makeRequest("https://cache.example.test/b.js", { reportErrors: false }),
        ]);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("propagates a scoped cancellation signal to nested requests", async () => {
        let requestSignal: AbortSignal | undefined;
        vi.spyOn(globalThis, "fetch").mockImplementation((_url, options) => {
            requestSignal = options?.signal ?? undefined;
            return new Promise<Response>((_resolve, reject) => {
                requestSignal?.addEventListener(
                    "abort",
                    () => reject(Object.assign(new Error("cancelled"), { name: "AbortError" })),
                    { once: true }
                );
            });
        });
        const controller = new AbortController();

        const request = withRequestSignal(controller.signal, () =>
            makeRequest("https://cancelled.example.test/chunk.js", { reportErrors: false })
        );
        await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
        controller.abort();

        await expect(request).resolves.toBeNull();
        expect(requestSignal?.aborted).toBe(true);
    });

    it("does not return a cached response after its request scope is cancelled", async () => {
        setDisableCache(false);
        const fetchSpy = vi.spyOn(globalThis, "fetch");
        vi.spyOn(fs, "existsSync").mockReturnValue(true);
        vi.spyOn(fs, "readFileSync").mockReturnValue(
            JSON.stringify({
                "https://cached.example.test/chunk.js": {
                    normal: {
                        status: 200,
                        body_b64: Buffer.from("const stale = true;").toString("base64"),
                        resp_headers: { "content-type": "application/javascript" },
                    },
                },
            })
        );
        const controller = new AbortController();
        controller.abort();

        await expect(
            withRequestSignal(controller.signal, () =>
                makeRequest("https://cached.example.test/chunk.js", { reportErrors: false })
            )
        ).resolves.toBeNull();

        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("propagates scoped cancellation through the AWS proxy request path", async () => {
        setUseProxy(true);
        setProxyMethod("aws");
        let awsSignal: AbortSignal | undefined;
        requestHarness.awsGet.mockImplementation((_url, _headers, signal?: AbortSignal) => {
            awsSignal = signal;
            return new Promise<string>((_resolve, reject) => {
                signal?.addEventListener(
                    "abort",
                    () => reject(Object.assign(new Error("cancelled"), { name: "AbortError" })),
                    { once: true }
                );
            });
        });
        const controller = new AbortController();

        const request = withRequestSignal(controller.signal, () =>
            makeRequest("https://aws.example.test/chunk.js", { reportErrors: false })
        );
        await vi.waitFor(() => expect(requestHarness.awsGet).toHaveBeenCalledTimes(1));
        controller.abort();

        await expect(request).resolves.toBeNull();
        expect(awsSignal?.aborted).toBe(true);
    });
});
