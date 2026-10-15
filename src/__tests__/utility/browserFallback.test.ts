import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({ launch: vi.fn() }));

vi.mock("../../utility/puppeteerInstance.js", () => ({ default: { launch: harness.launch } }));

import makeRequest from "../../utility/makeReq.js";
import { setDisableCache, setUseProxy } from "../../utility/globals.js";
import { resetOxylabsFallback } from "../../proxy/oxylabsFallback.js";
import { browserFallbackGuard } from "../../utility/browserFallbackGuard.js";
import { closeSharedBrowsers } from "../../utility/sharedBrowser.js";

const CHALLENGE_HTML = "<!doctype html><html><head><title>Just a moment...</title></head><body></body></html>";
const challengeResponse = (): Response =>
    new Response(CHALLENGE_HTML, {
        status: 200,
        headers: { server: "cloudflare", "cf-ray": "challenge-ray", "content-type": "text/html" },
    });

const fakeBrowser = (pageContent: () => string, pageUrl: () => string = () => "") => {
    const contexts: { close: ReturnType<typeof vi.fn> }[] = [];
    const browser = {
        connected: true,
        once: vi.fn(),
        close: vi.fn(async () => undefined),
        contexts,
        createBrowserContext: vi.fn(async () => {
            const context = {
                close: vi.fn(async () => undefined),
                newPage: vi.fn(async () => ({
                    authenticate: vi.fn(),
                    setExtraHTTPHeaders: vi.fn(),
                    setRequestInterception: vi.fn(),
                    on: vi.fn(),
                    goto: vi.fn(async () => null),
                    content: vi.fn(async () => pageContent()),
                    url: vi.fn(() => pageUrl()),
                })),
            };
            contexts.push(context);
            return context;
        }),
    };
    return browser;
};

/** Issues a request and lets the fallback's fixed 5s settle wait elapse on fake timers. */
const requestWithSettle = async (url: string): Promise<Response | null> => {
    const pending = makeRequest(url, { reportErrors: false });
    await vi.advanceTimersByTimeAsync(5_000);
    return pending;
};

beforeEach(() => {
    vi.useFakeTimers();
    setDisableCache(true);
    setUseProxy(false);
    resetOxylabsFallback();
    browserFallbackGuard.reset();
    harness.launch.mockReset();
});

afterEach(async () => {
    vi.useRealTimers();
    await closeSharedBrowsers();
    browserFallbackGuard.reset();
    setDisableCache(false);
    vi.restoreAllMocks();
});

describe("makeRequest headless-browser fallback", () => {
    it("reuses one browser and opens a fresh context for every blocked request", async () => {
        const browser = fakeBrowser(() => "<!doctype html><html><head><title>Article</title></head></html>");
        harness.launch.mockResolvedValue(browser);
        vi.spyOn(globalThis, "fetch").mockImplementation(async () => challengeResponse());

        for (const path of ["one", "two"]) {
            const response = await requestWithSettle(`https://site.example.test/${path}`);
            await expect(response?.text()).resolves.toContain("<title>Article</title>");
        }

        expect(harness.launch).toHaveBeenCalledTimes(1);
        expect(browser.createBrowserContext).toHaveBeenCalledTimes(2);
        for (const context of browser.contexts) expect(context.close).toHaveBeenCalledTimes(1);
    });

    it("returns the URL the browser's navigation ended on", async () => {
        const browser = fakeBrowser(
            () => "<!doctype html><html><head><title>Article</title></head></html>",
            () => "https://www.site.example.test/after-redirect/"
        );
        harness.launch.mockResolvedValue(browser);
        vi.spyOn(globalThis, "fetch").mockImplementation(async () => challengeResponse());

        const response = await requestWithSettle("https://site.example.test/");

        expect(response?.url).toBe("https://www.site.example.test/after-redirect/");
    });

    it("stops retrying a host in the browser after three consecutive uncleared challenges", async () => {
        const browser = fakeBrowser(() => CHALLENGE_HTML);
        harness.launch.mockResolvedValue(browser);
        vi.spyOn(globalThis, "fetch").mockImplementation(async () => challengeResponse());

        for (let page = 0; page < 5; page++) {
            await requestWithSettle(`https://blocked.example.test/page-${page}`);
        }

        expect(browser.createBrowserContext).toHaveBeenCalledTimes(3);
        expect(browserFallbackGuard.shouldAttempt("blocked.example.test")).toBe(false);

        await requestWithSettle("https://other.example.test/");
        expect(browser.createBrowserContext).toHaveBeenCalledTimes(4);
    });

    it("counts a failed browser navigation toward the host's failure streak", async () => {
        const browser = fakeBrowser(() => CHALLENGE_HTML);
        browser.createBrowserContext.mockRejectedValue(new Error("navigation failed"));
        harness.launch.mockResolvedValue(browser);
        vi.spyOn(globalThis, "fetch").mockImplementation(async () => challengeResponse());

        for (let page = 0; page < 4; page++) {
            await requestWithSettle(`https://broken.example.test/page-${page}`);
        }

        expect(browser.createBrowserContext).toHaveBeenCalledTimes(3);
    });
});
