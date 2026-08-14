import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { registerFatalHandlers } from "../../utility/fatalHandlers.js";

describe("registerFatalHandlers", () => {
    let exitSpy: ReturnType<typeof vi.spyOn>;
    let errorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
        errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
        registerFatalHandlers();
    });

    afterEach(() => {
        process.removeAllListeners("unhandledRejection");
        process.removeAllListeners("uncaughtException");
        exitSpy.mockRestore();
        errorSpy.mockRestore();
    });

    it("logs and exits with code 34 on an unhandled promise rejection", () => {
        process.emit("unhandledRejection", new Error("probe rejection"), Promise.resolve());

        expect(errorSpy).toHaveBeenCalledTimes(1);
        expect(String(errorSpy.mock.calls[0][0])).toContain("Unhandled promise rejection");
        expect(String(errorSpy.mock.calls[0][0])).toContain("probe rejection");
        expect(exitSpy).toHaveBeenCalledWith(34);
    });

    it("logs and exits with code 34 on an uncaught exception", () => {
        process.emit("uncaughtException", new Error("probe exception"), "uncaughtException");

        expect(errorSpy).toHaveBeenCalledTimes(1);
        expect(String(errorSpy.mock.calls[0][0])).toContain("Uncaught exception");
        expect(String(errorSpy.mock.calls[0][0])).toContain("probe exception");
        expect(exitSpy).toHaveBeenCalledWith(34);
    });
});
