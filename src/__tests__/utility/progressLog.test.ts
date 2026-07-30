import { afterEach, describe, expect, it, vi } from "vitest";
import {
    activateBarLogger,
    cleanupProgressResources,
    progressError,
    progressLog,
    progressWarn,
    withProgressResources,
} from "../../utility/progressLog.js";

afterEach(() => {
    vi.restoreAllMocks();
});

describe("progress logger lifecycle", () => {
    it("restores the outer logger when a nested activation is released", () => {
        const outer = { log: vi.fn() };
        const inner = { log: vi.fn() };
        const releaseOuter = activateBarLogger(outer);
        const releaseInner = activateBarLogger(inner);

        progressLog("inner message");
        releaseInner();
        progressWarn("outer message");
        releaseOuter();

        expect(inner.log).toHaveBeenCalledWith("inner message\n");
        expect(outer.log).toHaveBeenCalledWith("outer message\n");
    });

    it("removes only the activation owned by its cleanup token", () => {
        const outer = { log: vi.fn() };
        const inner = { log: vi.fn() };
        const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const releaseOuter = activateBarLogger(outer);
        const releaseInner = activateBarLogger(inner);

        releaseOuter();
        releaseOuter();
        progressError("still inner");
        releaseInner();
        progressError("fallback");

        expect(inner.log).toHaveBeenCalledWith("still inner\n");
        expect(outer.log).not.toHaveBeenCalled();
        expect(consoleSpy).toHaveBeenCalledWith("fallback");
    });

    it("does not install terminal-control loggers when their TTY scope is disabled", () => {
        const logger = { log: vi.fn() };
        const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const release = activateBarLogger(logger, false);

        progressError("plain non-TTY error");
        release();

        expect(logger.log).not.toHaveBeenCalled();
        expect(consoleSpy).toHaveBeenCalledWith("plain non-TTY error");
    });

    it("attempts every cleanup step and suppresses cleanup failures", () => {
        const attempted: string[] = [];

        expect(() =>
            cleanupProgressResources(
                () => {
                    attempted.push("bar");
                    throw new Error("bar failed");
                },
                () => {
                    attempted.push("resize");
                    throw new Error("resize failed");
                },
                () => {
                    attempted.push("logger");
                }
            )
        ).not.toThrow();

        expect(attempted).toEqual(["bar", "resize", "logger"]);
    });

    it("runs cleanup in finally without replacing the work failure", async () => {
        const attempted: string[] = [];
        const workError = new Error("work failed");

        await expect(
            withProgressResources(
                async () => {
                    throw workError;
                },
                () => {
                    attempted.push("bar");
                    throw new Error("bar failed");
                },
                () => {
                    attempted.push("logger");
                }
            )
        ).rejects.toBe(workError);

        expect(attempted).toEqual(["bar", "logger"]);
    });
});
