import { afterEach, describe, expect, it, vi } from "vitest";

// Minimal Puppeteer stand-in: page.goto() emits one response whose body never settles.
const harness = vi.hoisted(() => ({ onResponse: null as ((res: unknown) => void) | null }));

vi.mock("../../utility/makeReq.js", () => ({
    default: vi.fn(async () => null),
    getActivePuppeteerProxyArgs: vi.fn(() => ({})),
}));

vi.mock("../../utility/puppeteerInstance.js", () => ({
    default: {
        launch: vi.fn(async () => ({
            close: vi.fn(async () => undefined),
            newPage: vi.fn(async () => ({
                setDefaultNavigationTimeout: vi.fn(),
                createCDPSession: vi.fn(async () => ({ send: vi.fn(async () => undefined) })),
                setRequestInterception: vi.fn(async () => undefined),
                on: vi.fn((event: string, handler: (res: unknown) => void) => {
                    if (event === "response") harness.onResponse = handler;
                }),
                goto: vi.fn(async () => {
                    harness.onResponse?.({
                        url: () => "https://example.test/stream",
                        status: () => 200,
                        headers: () => ({ "content-type": "application/octet-stream" }),
                        text: () => new Promise<string>(() => {}),
                    });
                }),
                waitForNavigation: vi.fn(async () => undefined),
                content: vi.fn(async () => "<html></html>"),
            })),
        })),
    },
}));

import frameworkDetect, { settleResponseBodies } from "../../lazyLoad/techDetect/index.js";

const never = () => new Promise<void>(() => {});

afterEach(() => {
    vi.useRealTimers();
});

describe("settleResponseBodies", () => {
    it("resolves as soon as every body settles", async () => {
        await expect(settleResponseBodies([Promise.resolve(), Promise.reject(new Error("x"))])).resolves.toBe(
            undefined
        );
    });

    it("abandons a never-settling body after the settle deadline", async () => {
        vi.useFakeTimers();
        const done = vi.fn();
        void settleResponseBodies([never()], undefined, 500, 50).then(done);
        await vi.advanceTimersByTimeAsync(499);
        expect(done).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(done).toHaveBeenCalled();
    });

    it("abandons a never-settling body shortly after cancellation", async () => {
        vi.useFakeTimers();
        const controller = new AbortController();
        const done = vi.fn();
        void settleResponseBodies([never()], controller.signal, 60_000, 50).then(done);
        controller.abort();
        await vi.advanceTimersByTimeAsync(50);
        expect(done).toHaveBeenCalled();
    });
});

describe("frameworkDetect", () => {
    it("returns after cancellation even when a captured response body never settles", async () => {
        const controller = new AbortController();
        const detection = frameworkDetect("https://example.test", controller.signal);
        setTimeout(() => controller.abort(), 100);
        await expect(detection).resolves.toBeNull();
    }, 5_000);
});
