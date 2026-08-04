import { requestSkipCurrentTarget } from "../interruptHandler.js";

export type TargetStatus = "queued" | "running" | "completed" | "skipped" | "error";

export interface TargetState {
    url: string;
    hostDir: string;
    dir: string;
    status: TargetStatus;
    step: string | null;
    startedAt: number | null;
    finishedAt: number | null;
    error: string | null;
}

const targets = new Map<string, TargetState>();
const skipRequested = new Set<string>();
let currentUrl: string | null = null;

/**
 * Resets all in-memory dashboard state. Only needed for test isolation — a real
 * `run` process starts fresh, so production code never needs to call this.
 */
export const resetDashboardState = (): void => {
    targets.clear();
    skipRequested.clear();
    currentUrl = null;
};

export const registerTargets = (entries: { url: string; hostDir: string; dir: string }[]): void => {
    for (const { url, hostDir, dir } of entries) {
        targets.set(hostDir, {
            url,
            hostDir,
            dir,
            status: "queued",
            step: null,
            startedAt: null,
            finishedAt: null,
            error: null,
        });
    }
};

export const setCurrentUrl = (url: string | null): void => {
    currentUrl = url;
};

const byUrl = (url: string): TargetState | undefined => {
    for (const t of targets.values()) {
        if (t.url === url) return t;
    }
    return undefined;
};

export const markRunning = (url: string): void => {
    const t = byUrl(url);
    if (!t) return;
    t.status = "running";
    t.startedAt = Date.now();
};

/**
 * Records the current pipeline step for whichever target is currently running.
 * Wired up via printMsg.setHeaderListener() since only one target runs at a time
 * in the batch loop — this avoids threading a callback through every processUrl()
 * framework branch.
 */
export const markStep = (step: string): void => {
    if (!currentUrl) return;
    const t = byUrl(currentUrl);
    if (!t) return;
    t.step = step;
};

export const markCompleted = (url: string): void => {
    const t = byUrl(url);
    if (!t) return;
    t.status = "completed";
    t.finishedAt = Date.now();
};

export const markSkipped = (url: string): void => {
    const t = byUrl(url);
    if (!t) return;
    t.status = "skipped";
    t.finishedAt = Date.now();
};

export const markError = (url: string, message: string): void => {
    const t = byUrl(url);
    if (!t) return;
    t.status = "error";
    t.error = message;
    t.finishedAt = Date.now();
};

export const getAll = (): TargetState[] => Array.from(targets.values());

export const getByHostDir = (hostDir: string): TargetState | undefined => targets.get(hostDir);

/**
 * Requests that a target be skipped. If it's the currently-running target, this
 * cancels it in-flight via interruptHandler's programmatic skip (same effect as
 * choosing "skip target" from the SIGINT menu). Otherwise it's recorded so the
 * batch loop can skip it before it starts.
 */
export const requestSkip = (url: string): void => {
    if (url === currentUrl) {
        requestSkipCurrentTarget();
        return;
    }
    skipRequested.add(url);
};

export const isSkipRequested = (url: string): boolean => skipRequested.has(url);
