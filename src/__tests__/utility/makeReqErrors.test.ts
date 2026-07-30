import fs from "fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import makeRequest, { withRequestSignal } from "../../utility/makeReq.js";
import { setCacheOnly, setDisableCache, setProxyMethod, setRespCacheFile, setUseProxy } from "../../utility/globals.js";

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
    requestHarness.awsGet.mockReset();
});

afterEach(() => {
    setDisableCache(false);
    setUseProxy(false);
    setProxyMethod(null);
    setRespCacheFile(".resp_cache.json");
    if (temporaryCacheDirectory) {
        fs.rmSync(temporaryCacheDirectory, { recursive: true, force: true });
        temporaryCacheDirectory = undefined;
    }
    vi.restoreAllMocks();
});

describe("makeRequest error reporting ownership", () => {
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
