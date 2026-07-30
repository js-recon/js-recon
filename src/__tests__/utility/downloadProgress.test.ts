import { afterEach, describe, expect, it, vi } from "vitest";
import { stripVTControlCharacters } from "node:util";
import {
    createDownloadProgressOptions,
    DownloadProgress,
    formatDownloadProgress,
    type DownloadProgressBar,
    type DownloadProgressMultiBar,
} from "../../utility/downloadProgress.js";
import { progressLog, watchBarResize } from "../../utility/progressLog.js";

const snapshot = (total: number, processed: number, downloaded: number, failed: number, ignored: number) => ({
    total,
    processed,
    downloaded,
    failed,
    ignored,
    failures: {
        download: failed,
        invalidResponse: 0,
        format: 0,
        write: 0,
    },
});

const createBarHarness = () => {
    const bar: DownloadProgressBar = {
        options: { barsize: 0 },
        update: vi.fn(),
        setTotal: vi.fn(),
    };
    const multiBar: DownloadProgressMultiBar = {
        create: vi.fn(() => bar),
        log: vi.fn(),
        stop: vi.fn(),
    };
    return { bar, multiBar };
};

afterEach(() => {
    vi.restoreAllMocks();
});

describe("DownloadProgress", () => {
    it("creates and updates one TTY bar with dynamic totals and aggregate counters", () => {
        const { bar, multiBar } = createBarHarness();
        const cleanupResize = vi.fn();
        const progress = new DownloadProgress({
            isTTY: true,
            createMultiBar: () => multiBar,
            watchResize: () => cleanupResize,
        });

        progress.update(snapshot(2, 0, 0, 0, 0));
        progress.update(snapshot(5, 3, 2, 1, 0));

        expect(multiBar.create).toHaveBeenCalledTimes(1);
        expect(multiBar.create).toHaveBeenCalledWith(2, 0, {
            downloaded: 0,
            failed: 0,
            ignored: 0,
        });
        expect(bar.setTotal).toHaveBeenCalledWith(5);
        expect(bar.update).toHaveBeenLastCalledWith(3, {
            downloaded: 2,
            failed: 1,
            ignored: 0,
        });

        progress.stop();

        expect(cleanupResize).toHaveBeenCalledTimes(1);
        expect(multiBar.stop).toHaveBeenCalledTimes(1);
    });

    it("routes progress-aware messages through the active TTY multibar and releases it on stop", () => {
        const { multiBar } = createBarHarness();
        const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
        const progress = new DownloadProgress({
            isTTY: true,
            createMultiBar: () => multiBar,
            watchResize: () => vi.fn(),
        });

        progress.update(snapshot(1, 0, 0, 0, 0));
        progressLog("discovered another chunk");
        expect(multiBar.log).toHaveBeenCalledWith("discovered another chunk\n");
        expect(consoleSpy).not.toHaveBeenCalled();

        progress.stop();
        progressLog("after progress");
        expect(consoleSpy).toHaveBeenCalledWith("after progress");
    });

    it("does not construct a bar or emit terminal controls for non-TTY output", () => {
        const createMultiBar = vi.fn();
        const progress = new DownloadProgress({
            isTTY: false,
            createMultiBar,
            watchResize: () => vi.fn(),
        });

        progress.update(snapshot(100, 50, 45, 5, 0));
        progress.stop();

        expect(createMultiBar).not.toHaveBeenCalled();
    });

    it("does not create an empty progress bar", () => {
        const createMultiBar = vi.fn();
        const progress = new DownloadProgress({
            isTTY: true,
            createMultiBar,
            watchResize: () => vi.fn(),
        });

        progress.update(snapshot(0, 0, 0, 0, 0));
        progress.stop();

        expect(createMultiBar).not.toHaveBeenCalled();
    });

    it("disables itself when the terminal renderer fails without interrupting downloads", () => {
        const createMultiBar = vi.fn(() => {
            throw new Error("terminal renderer failed");
        });
        const progress = new DownloadProgress({
            isTTY: true,
            createMultiBar,
            watchResize: () => vi.fn(),
        });

        expect(() => progress.update(snapshot(2, 0, 0, 0, 0))).not.toThrow();
        expect(() => progress.update(snapshot(2, 1, 1, 0, 0))).not.toThrow();
        expect(createMultiBar).toHaveBeenCalledTimes(1);
    });

    it("releases the active logger without surfacing progress renderer cleanup failures", () => {
        const { multiBar } = createBarHarness();
        const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
        vi.mocked(multiBar.stop).mockImplementation(() => {
            throw new Error("renderer failed");
        });
        const progress = new DownloadProgress({
            isTTY: true,
            createMultiBar: () => multiBar,
            watchResize: () => vi.fn(),
        });

        progress.update(snapshot(1, 0, 0, 0, 0));
        expect(() => progress.stop()).not.toThrow();

        progressLog("logger recovered");
        expect(consoleSpy).toHaveBeenCalledWith("logger recovered");
        expect(multiBar.log).not.toHaveBeenCalledWith("logger recovered\n");
    });

    it("still stops the multibar when resize cleanup fails", () => {
        const { multiBar } = createBarHarness();
        const progress = new DownloadProgress({
            isTTY: true,
            createMultiBar: () => multiBar,
            watchResize: () => () => {
                throw new Error("resize cleanup failed");
            },
        });

        progress.update(snapshot(1, 0, 0, 0, 0));
        expect(() => progress.stop()).not.toThrow();
        expect(multiBar.stop).toHaveBeenCalledTimes(1);
    });

    it("uses a responsive format that never exceeds a narrow terminal", () => {
        const output = formatDownloadProgress(
            {},
            {
                progress: 0.5,
                eta: 1,
                startTime: 0,
                stopTime: null,
                total: 2998,
                value: 1499,
                maxWidth: 40,
            },
            { downloaded: 1200, failed: 299, ignored: 0 }
        );

        const visibleOutput = stripVTControlCharacters(output);
        expect(visibleOutput.length).toBeLessThanOrEqual(40);
        expect(visibleOutput).toContain("1499/2998");
        expect(visibleOutput).not.toContain("saved");
    });

    it("shows the full counters and a bar when the terminal is wide enough", () => {
        const output = formatDownloadProgress(
            {},
            {
                progress: 0.5,
                eta: 1,
                startTime: 0,
                stopTime: null,
                total: 100,
                value: 50,
                maxWidth: 120,
            },
            { downloaded: 45, failed: 5, ignored: 0 }
        );

        const visibleOutput = stripVTControlCharacters(output);
        // Leave the terminal's final column unused so auto-wrap cannot create
        // a stray blank line on terminals that wrap at the right edge.
        expect(visibleOutput.length).toBeLessThan(120);
        expect(visibleOutput).toContain("saved");
        expect(visibleOutput).toContain("failed");
        expect(visibleOutput).toContain("skipped");
        expect(visibleOutput).toContain("█");
    });

    it("disables cli-progress raw ANSI truncation because the formatter owns visible width", () => {
        expect(createDownloadProgressOptions().linewrap).toBe(false);
    });

    it("rebuilds cli-progress bar strings when the terminal is resized", () => {
        const columnsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");
        Object.defineProperty(process.stdout, "columns", { configurable: true, value: 40 });
        const bar = {
            options: {
                barsize: 1,
                barCompleteChar: "█",
                barIncompleteChar: "░",
                barCompleteString: "██",
                barIncompleteString: "░░",
            },
        };
        const cleanup = watchBarResize(bar, 20);

        try {
            process.emit("SIGWINCH");

            expect(bar.options.barsize).toBe(20);
            expect(bar.options.barCompleteString).toBe("█".repeat(21));
            expect(bar.options.barIncompleteString).toBe("░".repeat(21));
        } finally {
            cleanup();
            if (columnsDescriptor) {
                Object.defineProperty(process.stdout, "columns", columnsDescriptor);
            } else {
                delete (process.stdout as NodeJS.WriteStream & { columns?: number }).columns;
            }
        }
    });
});
