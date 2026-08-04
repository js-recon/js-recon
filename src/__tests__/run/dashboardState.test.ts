import { describe, it, expect, beforeEach } from "vitest";
import {
    resetDashboardState,
    registerTargets,
    setCurrentUrl,
    markRunning,
    markStep,
    markCompleted,
    markSkipped,
    markError,
    getAll,
    getByHostDir,
    requestSkip,
    isSkipRequested,
} from "../../run/dashboard/state.js";

const ENTRIES = [
    { url: "https://a.example.com", hostDir: "a.example.com", dir: "output/a.example.com" },
    { url: "https://b.example.com", hostDir: "b.example.com", dir: "output/b.example.com" },
];

describe("run/dashboard/state", () => {
    beforeEach(() => {
        resetDashboardState();
    });

    it("registers targets as queued with null timestamps", () => {
        registerTargets(ENTRIES);
        const all = getAll();
        expect(all).toHaveLength(2);
        expect(all[0]).toMatchObject({ url: ENTRIES[0].url, status: "queued", step: null, startedAt: null });
    });

    it("transitions a target through running -> completed", () => {
        registerTargets(ENTRIES);
        setCurrentUrl(ENTRIES[0].url);
        markRunning(ENTRIES[0].url);
        markStep("[1/8] Running lazyload...");
        markCompleted(ENTRIES[0].url);

        const t = getByHostDir(ENTRIES[0].hostDir);
        expect(t?.status).toBe("completed");
        expect(t?.step).toBe("[1/8] Running lazyload...");
        expect(t?.startedAt).not.toBeNull();
        expect(t?.finishedAt).not.toBeNull();
    });

    it("markStep is a no-op when no current URL is set", () => {
        registerTargets(ENTRIES);
        markStep("should not apply anywhere");
        expect(getByHostDir(ENTRIES[0].hostDir)?.step).toBeNull();
    });

    it("markSkipped and markError set status independently of markCompleted", () => {
        registerTargets(ENTRIES);
        markSkipped(ENTRIES[0].url);
        markError(ENTRIES[1].url, "boom");

        expect(getByHostDir(ENTRIES[0].hostDir)?.status).toBe("skipped");
        const errored = getByHostDir(ENTRIES[1].hostDir);
        expect(errored?.status).toBe("error");
        expect(errored?.error).toBe("boom");
    });

    it("requestSkip on a queued (non-current) target marks it for the batch loop to skip", () => {
        registerTargets(ENTRIES);
        setCurrentUrl(ENTRIES[0].url); // a different target is currently running
        requestSkip(ENTRIES[1].url);

        expect(isSkipRequested(ENTRIES[1].url)).toBe(true);
        expect(isSkipRequested(ENTRIES[0].url)).toBe(false);
    });

    it("requestSkip on the currently-running target does not add it to the queued-skip set", () => {
        registerTargets(ENTRIES);
        setCurrentUrl(ENTRIES[0].url);
        requestSkip(ENTRIES[0].url);

        // Cancellation of the in-flight target goes through interruptHandler's
        // requestSkipCurrentTarget() instead — it should not show up here.
        expect(isSkipRequested(ENTRIES[0].url)).toBe(false);
    });

    it("getByHostDir returns undefined for an unknown host", () => {
        registerTargets(ENTRIES);
        expect(getByHostDir("unknown.example.com")).toBeUndefined();
    });
});
