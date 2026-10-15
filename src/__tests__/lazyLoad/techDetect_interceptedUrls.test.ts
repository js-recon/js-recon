import { describe, expect, it, vi } from "vitest";

// Puppeteer stand-in whose page "requests" the URLs queued in harness.requests during goto().
const harness = vi.hoisted(() => ({ requests: [] as string[] }));

vi.mock("../../utility/makeReq.js", () => ({
    default: vi.fn(async () => null),
    getActivePuppeteerProxyArgs: vi.fn(() => ({})),
}));

vi.mock("../../utility/puppeteerInstance.js", () => ({
    default: {
        launch: vi.fn(async () => {
            const handlers: Record<string, (arg: unknown) => void> = {};
            const page = {
                authenticate: vi.fn(),
                setExtraHTTPHeaders: vi.fn(),
                setDefaultNavigationTimeout: vi.fn(),
                createCDPSession: vi.fn(async () => ({ send: vi.fn(async () => undefined) })),
                setRequestInterception: vi.fn(async () => undefined),
                on: vi.fn((event: string, handler: (arg: unknown) => void) => {
                    handlers[event] = handler;
                }),
                goto: vi.fn(async () => {
                    for (const url of harness.requests) {
                        handlers.request?.({
                            url: () => url,
                            headers: () => ({}),
                            continue: vi.fn(async () => undefined),
                            abort: vi.fn(async () => undefined),
                        });
                    }
                    return null;
                }),
                waitForNavigation: vi.fn(async () => null),
                content: vi.fn(async () => "<!doctype html><html><head></head><body></body></html>"),
            };
            return { close: vi.fn(async () => undefined), newPage: vi.fn(async () => page) };
        }),
    },
}));

import frameworkDetect, { getLastInterceptedUrls } from "../../lazyLoad/techDetect/index.js";

describe("frameworkDetect intercepted URLs", () => {
    it("publishes the URLs the target's page requested", async () => {
        harness.requests = ["https://first.example.test/", "https://first.example.test/app.js"];

        await frameworkDetect("https://first.example.test/");

        expect(getLastInterceptedUrls()).toEqual(harness.requests);
    }, 15_000);

    it("does not hand the previous target's capture to a detection that is cancelled", async () => {
        harness.requests = ["https://first.example.test/app.js"];
        await frameworkDetect("https://first.example.test/");
        expect(getLastInterceptedUrls()).toEqual(["https://first.example.test/app.js"]);

        const controller = new AbortController();
        controller.abort();
        await expect(frameworkDetect("https://second.example.test/", controller.signal)).resolves.toBeNull();

        expect(getLastInterceptedUrls()).toEqual([]);
    }, 15_000);
});
