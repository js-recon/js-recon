import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TargetCloseError } from "puppeteer";
import { closeForCancellation, registerFatalHandlers } from "../../utility/fatalHandlers.js";

describe("registerFatalHandlers", () => {
    let exitSpy: ReturnType<typeof vi.spyOn>;
    let errorSpy: ReturnType<typeof vi.spyOn>;
    let teardown: () => void;

    beforeEach(() => {
        exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
        errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
        teardown = registerFatalHandlers();
    });

    afterEach(() => {
        teardown();
        exitSpy.mockRestore();
        errorSpy.mockRestore();
    });

    it("logs and exits with code 34 on an unhandled promise rejection", () => {
        process.emit("unhandledRejection", new Error("probe rejection"), Promise.resolve());

        expect(errorSpy).toHaveBeenCalledTimes(1);
        expect(String(errorSpy.mock.calls[0][0])).toContain("Unhandled promise rejection");
        expect(String(errorSpy.mock.calls[0][1])).toContain("probe rejection");
        expect(exitSpy).toHaveBeenCalledWith(34);
    });

    it("logs and exits with code 34 on an uncaught exception", () => {
        process.emit("uncaughtException", new Error("probe exception"), "uncaughtException");

        expect(errorSpy).toHaveBeenCalledTimes(1);
        expect(String(errorSpy.mock.calls[0][0])).toContain("Uncaught exception");
        expect(String(errorSpy.mock.calls[0][1])).toContain("probe exception");
        expect(exitSpy).toHaveBeenCalledWith(34);
    });

    it("exits with code 34 on a Symbol rejection reason without throwing", () => {
        expect(() => {
            process.emit("unhandledRejection", Symbol("probe symbol"), Promise.resolve());
        }).not.toThrow();

        expect(exitSpy).toHaveBeenCalledWith(34);
    });

    it("exits with code 34 on a non-Error thrown value without throwing", () => {
        expect(() => {
            process.emit("uncaughtException", "probe string exception" as unknown as Error, "uncaughtException");
        }).not.toThrow();

        expect(exitSpy).toHaveBeenCalledWith(34);
    });

    it("removes only its own listeners on teardown, preserving others", () => {
        const otherListener = vi.fn();
        process.on("unhandledRejection", otherListener);

        teardown();
        process.emit("unhandledRejection", new Error("after teardown"), Promise.resolve());

        expect(otherListener).toHaveBeenCalledTimes(1);
        expect(exitSpy).not.toHaveBeenCalled();

        process.off("unhandledRejection", otherListener);
    });

    describe("cancellation-owned browser close", () => {
        afterEach(() => {
            vi.useRealTimers();
        });

        it("absorbs a TargetCloseError while a cancellation close is in flight or within its grace window", async () => {
            vi.useFakeTimers();
            let finishClose!: () => void;
            const closing = closeForCancellation(() => new Promise<void>((r) => (finishClose = r)));

            process.emit("unhandledRejection", new TargetCloseError("Target closed"), Promise.resolve());
            finishClose();
            await closing;
            process.emit("unhandledRejection", new TargetCloseError("Target closed"), Promise.resolve());
            expect(exitSpy).not.toHaveBeenCalled();

            await vi.advanceTimersByTimeAsync(1_000);
            process.emit("unhandledRejection", new TargetCloseError("Target closed"), Promise.resolve());
            expect(exitSpy).toHaveBeenCalledWith(34);
        });

        it("still exits 34 on other rejections during a cancellation close", async () => {
            vi.useFakeTimers();
            await closeForCancellation(async () => undefined);
            process.emit("unhandledRejection", new Error("real failure"), Promise.resolve());
            expect(exitSpy).toHaveBeenCalledWith(34);
            await vi.advanceTimersByTimeAsync(1_000);
        });

        it("exits 34 on a TargetCloseError with no cancellation close", () => {
            process.emit("unhandledRejection", new TargetCloseError("Target closed"), Promise.resolve());
            expect(exitSpy).toHaveBeenCalledWith(34);
        });

        it("never rejects when the close itself fails", async () => {
            vi.useFakeTimers();
            await expect(closeForCancellation(async () => Promise.reject(new Error("gone")))).resolves.toBeUndefined();
            await vi.advanceTimersByTimeAsync(1_000);
        });
    });
});
