import chalk from "chalk";
import cliProgress from "cli-progress";
import type { Options as CliProgressOptions, Params as CliProgressParams } from "cli-progress";
import type { DownloadProgressSnapshot } from "../lazyLoad/downloadQueue.js";
import { activateBarLogger, cleanupProgressResources, computeBarSize, watchBarResize } from "./progressLog.js";

export interface DownloadProgressBar {
    options?: { barsize?: number };
    update(current: number, payload?: object): void;
    setTotal(total: number): void;
}

export interface DownloadProgressMultiBar {
    create(total: number, startValue: number, payload?: object): DownloadProgressBar;
    log(data: string): void;
    update?(): void;
    stop(): void;
}

interface DownloadProgressOptions {
    isTTY?: boolean;
    createMultiBar?: () => DownloadProgressMultiBar;
    watchResize?: (bar: DownloadProgressBar, overhead: number) => () => void;
}

const FORMAT_OVERHEAD = 91;

interface DownloadProgressPayload {
    downloaded: number;
    failed: number;
    ignored: number;
}

const renderBar = (progress: number, size: number): string => {
    const completeSize = Math.round(progress * size);
    return "█".repeat(completeSize) + "░".repeat(size - completeSize);
};

export const formatDownloadProgress = (
    _options: CliProgressOptions,
    params: CliProgressParams,
    payload: DownloadProgressPayload
): string => {
    const maxWidth = Math.max(1, params.maxWidth || 80);
    // Avoid the terminal's final column: writing into it can trigger an
    // automatic wrap and leave a stray blank line below the progress bar.
    const renderWidth = Math.max(1, maxWidth - 1);
    const percentage = Math.floor(params.progress * 100);
    const label = "[i] Downloading chunks ";
    const details = `${percentage}% | ${params.value}/${params.total} | ${payload.downloaded} saved | ${payload.failed} failed | ${payload.ignored} skipped`;
    const barSize = renderWidth - label.length - details.length - 3;

    if (barSize >= 8) {
        return `${chalk.cyan(label)}[${renderBar(params.progress, barSize)}] ${details}`;
    }

    const compactLabel = "[i] Chunks ";
    const compactDetails = `${params.value}/${params.total} | +${payload.downloaded} !${payload.failed} -${payload.ignored}`;
    const compact = `${chalk.cyan(compactLabel)}${compactDetails}`;
    if (compactLabel.length + compactDetails.length <= renderWidth) return compact;

    const minimal = `${params.value}/${params.total} +${payload.downloaded} !${payload.failed}`;
    return minimal.slice(0, renderWidth);
};

const payloadFor = (progress: DownloadProgressSnapshot) => ({
    downloaded: progress.downloaded,
    failed: progress.failed,
    ignored: progress.ignored,
});

export const createDownloadProgressOptions = (): CliProgressOptions => ({
    format: formatDownloadProgress,
    barsize: computeBarSize(FORMAT_OVERHEAD),
    hideCursor: false,
    clearOnComplete: true,
    stopOnComplete: false,
    forceRedraw: true,
    // The formatter already budgets visible width. cli-progress's linewrap
    // mode truncates raw strings and therefore mistakes ANSI bytes for columns.
    linewrap: false,
    stream: process.stdout,
});

const createDefaultMultiBar = (): DownloadProgressMultiBar =>
    new cliProgress.MultiBar(createDownloadProgressOptions(), cliProgress.Presets.shades_classic);

/** TTY-only renderer for the aggregate state emitted by DownloadQueue. */
export class DownloadProgress {
    private readonly isTTY: boolean;
    private readonly createMultiBar: () => DownloadProgressMultiBar;
    private readonly resizeWatcher: (bar: DownloadProgressBar, overhead: number) => () => void;
    private multiBar: DownloadProgressMultiBar | null = null;
    private bar: DownloadProgressBar | null = null;
    private stopResize: (() => void) | null = null;
    private releaseLogger: (() => void) | null = null;
    private total = 0;
    private disabled = false;

    constructor(options: DownloadProgressOptions = {}) {
        this.isTTY = options.isTTY ?? Boolean(process.stdout.isTTY);
        this.createMultiBar = options.createMultiBar ?? createDefaultMultiBar;
        this.resizeWatcher = options.watchResize ?? watchBarResize;
    }

    update(progress: DownloadProgressSnapshot): void {
        if (!this.isTTY || this.disabled || progress.total === 0) return;

        try {
            if (!this.bar) {
                this.multiBar = this.createMultiBar();
                this.bar = this.multiBar.create(progress.total, progress.processed, payloadFor(progress));
                this.total = progress.total;
                this.stopResize = this.resizeWatcher(this.bar, FORMAT_OVERHEAD);
                this.releaseLogger = activateBarLogger(this.multiBar);
                return;
            }

            if (progress.total !== this.total) {
                this.bar.setTotal(progress.total);
                this.total = progress.total;
            }
            this.bar.update(progress.processed, payloadFor(progress));
        } catch {
            // Rendering is observational and must never interrupt downloads.
            this.disabled = true;
            this.stop();
        }
    }

    stop(): void {
        const multiBar = this.multiBar;
        if (!multiBar) return;

        const stopResize = this.stopResize;
        const releaseLogger = this.releaseLogger;
        this.multiBar = null;
        this.bar = null;
        this.stopResize = null;
        this.releaseLogger = null;

        cleanupProgressResources(
            () => stopResize?.(),
            () => multiBar.update?.(),
            () => multiBar.stop(),
            () => releaseLogger?.()
        );
    }
}

export default DownloadProgress;
