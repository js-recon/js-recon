import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import makeRequest from "../../utility/makeReq.js";
import { setCacheOnly, setDisableCache, setRespCacheFile, setUseProxy } from "../../utility/globals.js";
import { closeCacheDb } from "../../utility/cacheDb.js";
import { resetOxylabsFallback } from "../../proxy/oxylabsFallback.js";
import { withResponseUrl } from "../../utility/responseUrl.js";

const LANDING = "https://www.example.test/landing/";
// The platform fetch reports where a followed redirect chain ended in Response.url.
const redirectedResponse = (): Response =>
    withResponseUrl(new Response("<!doctype html><html><head><title>Landing</title></head></html>"), LANDING);

let cacheDirectory: string | undefined;

beforeEach(() => {
    setUseProxy(false);
    setCacheOnly(false);
    resetOxylabsFallback();
});

afterEach(() => {
    vi.restoreAllMocks();
    setCacheOnly(false);
    setDisableCache(false);
    closeCacheDb();
    setRespCacheFile(".resp_cache.db");
    if (cacheDirectory) fs.rmSync(cacheDirectory, { recursive: true, force: true });
    cacheDirectory = undefined;
});

describe("makeRequest final URL", () => {
    it("reports where a redirected request was served from", async () => {
        setDisableCache(true);
        vi.spyOn(globalThis, "fetch").mockImplementation(async () => redirectedResponse());

        const response = await makeRequest("https://example.test/", { reportErrors: false });

        expect(response?.url).toBe(LANDING);
    });

    it("keeps the final URL through the response cache", async () => {
        cacheDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "js-recon-final-url-"));
        setRespCacheFile(path.join(cacheDirectory, ".resp_cache.db"));
        setDisableCache(false);
        vi.spyOn(globalThis, "fetch").mockImplementation(async () => redirectedResponse());
        await makeRequest("https://example.test/", { reportErrors: false });

        setCacheOnly(true);
        const cached = await makeRequest("https://example.test/", { reportErrors: false });

        expect(cached?.url).toBe(LANDING);
        await expect(cached?.text()).resolves.toContain("<title>Landing</title>");
    });
});
