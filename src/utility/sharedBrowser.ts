import type { Browser, LaunchOptions } from "puppeteer";
import puppeteer from "./puppeteerInstance.js";

/**
 * One headless browser per distinct launch configuration, shared by callers that only need a
 * short-lived page (the CDN/WAF fallback in `makeReq.ts`). Launching a browser per request costs a
 * full Chrome start-up each time, and on a challenge-heavy crawl that is thousands of launches;
 * when the tool runs as PID 1 in a container without an init process, every launch also leaves
 * Chrome's helper processes behind as zombies until the node runs out of PIDs.
 *
 * A browser that has had no users for SHARED_BROWSER_IDLE_MS closes itself, and a browser that
 * disconnects (crash, external kill) is dropped and relaunched by the next caller.
 */
const SHARED_BROWSER_IDLE_MS = 30_000;

interface SharedBrowserEntry {
    readonly browser: Promise<Browser>;
    users: number;
    idleTimer: NodeJS.Timeout | null;
}

export interface SharedBrowserLease {
    readonly browser: Browser;
    /** Hands the browser back; the last release starts the idle-close timer. Idempotent. */
    release(): void;
}

const sharedBrowsers = new Map<string, SharedBrowserEntry>();

const launchKey = (options: LaunchOptions): string =>
    JSON.stringify([
        options.executablePath ?? null,
        options.headless ?? null,
        options.args ?? [],
        options.handleSIGINT ?? null,
    ]);

const clearIdleTimer = (entry: SharedBrowserEntry): void => {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
};

/** Stops handing out an entry; callers that already hold its browser keep using it. */
const retire = (key: string, entry: SharedBrowserEntry): void => {
    if (sharedBrowsers.get(key) === entry) sharedBrowsers.delete(key);
    clearIdleTimer(entry);
};

const launchEntry = (key: string, options: LaunchOptions): SharedBrowserEntry => {
    const entry: SharedBrowserEntry = { browser: puppeteer.launch(options), users: 0, idleTimer: null };
    sharedBrowsers.set(key, entry);
    entry.browser.then(
        (browser) => browser.once("disconnected", () => retire(key, entry)),
        () => retire(key, entry)
    );
    return entry;
};

const closeEntry = async (entry: SharedBrowserEntry): Promise<void> => {
    try {
        await (await entry.browser).close();
    } catch {
        // failed launch or already closed/disconnected
    }
};

/**
 * Leases the shared browser for `options`, launching it on first use. Callers should open their
 * own browser context per request (so cookies and storage never cross requests) and must call
 * `release()` when done.
 */
export const acquireSharedBrowser = async (options: LaunchOptions): Promise<SharedBrowserLease> => {
    const key = launchKey(options);
    for (let attempt = 0; ; attempt++) {
        const entry = sharedBrowsers.get(key) ?? launchEntry(key, options);
        entry.users++;
        clearIdleTimer(entry);

        let browser: Browser;
        try {
            browser = await entry.browser;
        } catch (err) {
            entry.users--;
            throw err;
        }
        if (!browser.connected) {
            // Disconnected before its "disconnected" event was handled; relaunch once.
            entry.users--;
            retire(key, entry);
            if (entry.users === 0) void closeEntry(entry);
            if (attempt === 0) continue;
            throw new Error("Shared headless browser disconnected immediately after launch");
        }

        let released = false;
        return {
            browser,
            release: () => {
                if (released) return;
                released = true;
                entry.users--;
                if (entry.users > 0) return;
                if (sharedBrowsers.get(key) !== entry) {
                    // Retired (closeSharedBrowsers or a disconnect) while still leased.
                    void closeEntry(entry);
                    return;
                }
                entry.idleTimer = setTimeout(() => {
                    retire(key, entry);
                    void closeEntry(entry);
                }, SHARED_BROWSER_IDLE_MS);
                entry.idleTimer.unref();
            },
        };
    }
};

/**
 * Closes every idle shared browser now, e.g. at the end of a module run so the process can exit.
 * A browser that is still leased is closed when its last lease is released instead, so in-flight
 * pages are never torn down underneath their callers.
 */
export const closeSharedBrowsers = async (): Promise<void> => {
    const entries = [...sharedBrowsers.entries()];
    for (const [key, entry] of entries) retire(key, entry);
    await Promise.all(entries.filter(([, entry]) => entry.users === 0).map(([, entry]) => closeEntry(entry)));
};
