import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({ launch: vi.fn() }));

vi.mock("../../utility/puppeteerInstance.js", () => ({ default: { launch: harness.launch } }));

import { acquireSharedBrowser, closeSharedBrowsers } from "../../utility/sharedBrowser.js";

interface FakeBrowser {
    connected: boolean;
    close: ReturnType<typeof vi.fn>;
    once: (event: string, handler: () => void) => void;
    disconnect: () => void;
}

const fakeBrowser = (): FakeBrowser => {
    const handlers: (() => void)[] = [];
    const browser: FakeBrowser = {
        connected: true,
        close: vi.fn(async () => {
            browser.connected = false;
        }),
        once: (event, handler) => {
            if (event === "disconnected") handlers.push(handler);
        },
        disconnect: () => {
            browser.connected = false;
            handlers.forEach((handler) => handler());
        },
    };
    return browser;
};

const OPTIONS = { headless: true, args: ["--no-sandbox"] };

beforeEach(() => {
    harness.launch.mockReset();
    harness.launch.mockImplementation(async () => fakeBrowser());
});

afterEach(async () => {
    vi.useRealTimers();
    await closeSharedBrowsers();
});

describe("acquireSharedBrowser", () => {
    it("launches one browser for every lease with the same launch options", async () => {
        const first = await acquireSharedBrowser(OPTIONS);
        const second = await acquireSharedBrowser({ ...OPTIONS, args: [...OPTIONS.args] });

        expect(second.browser).toBe(first.browser);
        expect(harness.launch).toHaveBeenCalledTimes(1);
        first.release();
        second.release();
    });

    it("launches a separate browser for different launch options", async () => {
        const direct = await acquireSharedBrowser(OPTIONS);
        const proxied = await acquireSharedBrowser({ ...OPTIONS, args: ["--proxy-server=http://proxy:8080"] });

        expect(proxied.browser).not.toBe(direct.browser);
        expect(harness.launch).toHaveBeenCalledTimes(2);
        direct.release();
        proxied.release();
    });

    it("relaunches after the shared browser disconnects", async () => {
        const first = await acquireSharedBrowser(OPTIONS);
        first.release();
        (first.browser as unknown as FakeBrowser).disconnect();

        const second = await acquireSharedBrowser(OPTIONS);

        expect(second.browser).not.toBe(first.browser);
        expect(harness.launch).toHaveBeenCalledTimes(2);
        second.release();
    });

    it("propagates a failed launch and launches again on the next lease", async () => {
        harness.launch.mockRejectedValueOnce(new Error("no chrome"));

        await expect(acquireSharedBrowser(OPTIONS)).rejects.toThrow("no chrome");
        const lease = await acquireSharedBrowser(OPTIONS);

        expect(harness.launch).toHaveBeenCalledTimes(2);
        lease.release();
    });

    it("closes the browser only after it has been idle for 30 seconds", async () => {
        vi.useFakeTimers();
        const lease = await acquireSharedBrowser(OPTIONS);
        const browser = lease.browser as unknown as FakeBrowser;

        await vi.advanceTimersByTimeAsync(60_000);
        expect(browser.close).not.toHaveBeenCalled();

        lease.release();
        lease.release(); // idempotent
        await vi.advanceTimersByTimeAsync(29_000);
        expect(browser.close).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1_000);
        expect(browser.close).toHaveBeenCalledTimes(1);
    });

    it("keeps an idle browser open when it is leased again before the idle timeout", async () => {
        vi.useFakeTimers();
        const first = await acquireSharedBrowser(OPTIONS);
        first.release();
        await vi.advanceTimersByTimeAsync(20_000);

        const second = await acquireSharedBrowser(OPTIONS);
        await vi.advanceTimersByTimeAsync(20_000);

        expect(second.browser).toBe(first.browser);
        expect((first.browser as unknown as FakeBrowser).close).not.toHaveBeenCalled();
        second.release();
    });
});

describe("closeSharedBrowsers", () => {
    it("closes idle browsers immediately", async () => {
        const lease = await acquireSharedBrowser(OPTIONS);
        lease.release();

        await closeSharedBrowsers();

        expect((lease.browser as unknown as FakeBrowser).close).toHaveBeenCalledTimes(1);
    });

    it("defers closing a leased browser until its last lease is released", async () => {
        const lease = await acquireSharedBrowser(OPTIONS);
        const browser = lease.browser as unknown as FakeBrowser;

        await closeSharedBrowsers();
        expect(browser.close).not.toHaveBeenCalled();

        lease.release();
        await vi.waitFor(() => expect(browser.close).toHaveBeenCalledTimes(1));
    });

    it("hands out a fresh browser after closing", async () => {
        const first = await acquireSharedBrowser(OPTIONS);
        first.release();
        await closeSharedBrowsers();

        const second = await acquireSharedBrowser(OPTIONS);

        expect(second.browser).not.toBe(first.browser);
        second.release();
    });
});
