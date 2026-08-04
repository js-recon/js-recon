import chalk from "chalk";
import path from "path";
import fs from "fs";
import prettier from "prettier";
import makeRequest, { isRequestCancelled } from "../utility/makeReq.js";
import { getURLDirectory, hostMatchesScope } from "../utility/urlUtils.js";
import { getScope } from "./globals.js";
import { progressLog, progressError, progressWarn } from "../utility/progressLog.js";
import { getDownloadedAssetKind, readDownloadedAssetResponse } from "./downloadResponse.js";
import { getSanitizedAssetFilename, resolveAssetOutputDirectory } from "./outputPath.js";
import * as globalsUtil from "../utility/globals.js";

export interface DownloadQueueOptions {
    /** Called whenever unique work is queued or a URL finishes processing. */
    onProgress?: (progress: DownloadProgressSnapshot) => void;
    /** Replace per-file errors with aggregate progress and summary counts. */
    compactOutput?: boolean;
    /** True when `output` is a batch per-target root that may already end in its target host. */
    alreadyBatchTargetRoot?: boolean;
}

export interface DownloadProgressSnapshot {
    readonly processed: number;
    readonly total: number;
    readonly downloaded: number;
    readonly failed: number;
    readonly ignored: number;
    readonly failures: DownloadFailureCounts;
}

export interface DownloadFailureCounts {
    readonly download: number;
    readonly invalidResponse: number;
    readonly format: number;
    readonly write: number;
}

type DownloadFailureKind = keyof DownloadFailureCounts;

const EMPTY_FAILURE_COUNTS: DownloadFailureCounts = Object.freeze({
    download: 0,
    invalidResponse: 0,
    format: 0,
    write: 0,
});

const PRETTIER_SIZE_LIMIT = 500 * 1024;

/**
 * A concurrent download queue that starts downloading JS files as soon as URLs
 * are pushed, without waiting for discovery to finish.
 *
 * Usage:
 *   const q = new DownloadQueue(output, concurrency);
 *   q.push(someUrls);          // starts downloading immediately
 *   q.push(moreUrls);          // safe to call any time
 *   await q.drain();           // wait for all downloads to complete
 */
export class DownloadQueue {
    private readonly output: string;
    private readonly concurrency: number;

    /** Tracks every URL ever enqueued to avoid duplicate downloads. */
    private readonly seen = new Set<string>();

    /** Pending URLs waiting for a free worker slot. */
    private readonly pending: string[] = [];

    /** Number of worker coroutines currently executing a download. */
    private activeWorkers = 0;

    /** Callbacks waiting for the queue to empty. */
    private drainCallbacks: (() => void)[] = [];

    /** Stats */
    private downloadCount = 0;
    private processedCount = 0;
    private failureCounts: DownloadFailureCounts = EMPTY_FAILURE_COUNTS;
    private ignoredCount = 0;
    private ignoredFiles: string[] = [];
    private ignoredDomains: string[] = [];

    private readonly onProgress?: DownloadQueueOptions["onProgress"];
    private readonly compactOutput: boolean;
    private readonly alreadyBatchTargetRoot: boolean;
    private progressObserverActive: boolean;

    constructor(output: string, concurrency: number, options: DownloadQueueOptions = {}) {
        this.output = output;
        this.concurrency = Math.max(1, concurrency);
        this.onProgress = options.onProgress;
        this.compactOutput = options.compactOutput ?? false;
        this.alreadyBatchTargetRoot = options.alreadyBatchTargetRoot ?? false;
        this.progressObserverActive = Boolean(options.onProgress);
        fs.mkdirSync(output, { recursive: true });
    }

    get totalEnqueued(): number {
        return this.seen.size;
    }

    get progress(): DownloadProgressSnapshot {
        return this.createProgressSnapshot();
    }

    /**
     * Enqueue URLs for download. Already-seen URLs are silently skipped.
     * New workers are spawned immediately up to the configured concurrency.
     */
    push(urls: string[]): void {
        const fresh: string[] = [];
        for (const u of urls) {
            if (!this.seen.has(u)) {
                this.seen.add(u);
                fresh.push(u);
            }
        }
        if (fresh.length === 0) return;

        this.pending.push(...fresh);
        this.emitProgress();
        this.spawnWorkers();
    }

    /** Returns a Promise that resolves once all pending downloads are complete. */
    drain(): Promise<void> {
        if (this.activeWorkers === 0 && this.pending.length === 0) {
            return Promise.resolve();
        }
        return new Promise<void>((resolve) => {
            this.drainCallbacks.push(resolve);
        });
    }

    /** Print a summary of ignored files. */
    printSummary(): void {
        if (this.compactOutput && this.processedCount > 0) {
            const failedCount = this.getFailedCount();
            const { download, invalidResponse, format, write } = this.failureCounts;
            const failureSummary = `${download} download, ${invalidResponse} invalid response, ${format} format, ${write} write`;
            const summary = `[${failedCount > 0 ? "!" : "✓"}] Processed ${this.processedCount} JS chunks: ${this.downloadCount} downloaded, ${failedCount} failed (${failureSummary}), ${this.ignoredCount} ignored`;
            if (failedCount > 0) {
                progressWarn(chalk.yellow(summary));
            } else {
                progressLog(chalk.green(summary));
            }
            return;
        }

        if (this.ignoredFiles.length > 0) {
            progressLog(
                chalk.yellow(
                    `[i] Ignored ${this.ignoredFiles.length} files across ${this.ignoredDomains.length} domain(s) - ${this.ignoredDomains.join(", ")}`
                )
            );
        }
        if (this.downloadCount > 0) {
            progressLog(chalk.green(`[✓] Downloaded ${this.downloadCount} JS chunks to ${this.output} directory`));
        }
    }

    // ── internals ────────────────────────────────────────────────────────

    private createProgressSnapshot(): DownloadProgressSnapshot {
        return Object.freeze({
            processed: this.processedCount,
            total: this.seen.size,
            downloaded: this.downloadCount,
            failed: this.getFailedCount(),
            ignored: this.ignoredCount,
            failures: Object.freeze({ ...this.failureCounts }),
        });
    }

    private emitProgress(): void {
        if (!this.onProgress || !this.progressObserverActive) return;

        try {
            this.onProgress(this.createProgressSnapshot());
        } catch (err) {
            this.progressObserverActive = false;
            this.reportWarning(chalk.yellow(`[!] Download progress observer disabled after an error: ${err}`));
        }
    }

    private getFailedCount(): number {
        const { download, invalidResponse, format, write } = this.failureCounts;
        return download + invalidResponse + format + write;
    }

    private recordFailure(kind: DownloadFailureKind): void {
        this.failureCounts = Object.freeze({
            ...this.failureCounts,
            [kind]: this.failureCounts[kind] + 1,
        });
    }

    private reportError(message: string): void {
        if (!this.compactOutput) progressError(message);
    }

    private reportWarning(message: string): void {
        if (!this.compactOutput) progressWarn(message);
    }

    private spawnWorkers(): void {
        while (this.activeWorkers < this.concurrency && this.pending.length > 0) {
            this.activeWorkers++;
            this.runWorker();
        }
    }

    private async runWorker(): Promise<void> {
        try {
            while (this.pending.length > 0) {
                const url = this.pending.shift()!;
                await this.processOne(url);
            }
        } finally {
            this.activeWorkers--;
            if (this.activeWorkers === 0 && this.pending.length === 0) {
                const callbacks = this.drainCallbacks.splice(0);
                for (const cb of callbacks) cb();
            }
        }
    }

    private async processOne(url: string): Promise<void> {
        try {
            if (isRequestCancelled()) {
                this.ignoredCount++;
                return;
            }
            if (
                !url.match(/(\.mjs\.map|\.mjs|\.js|\.json|\.js\.map|\.vue)/) ||
                url.match(/lang\.(css|scss|sass|less|styl)/)
            ) {
                this.ignoredCount++;
                if (!this.compactOutput) progressLog(chalk.yellow(`[i] Ignored ${url}`));
                return;
            }

            const { rawHost } = getURLDirectory(url);

            if (!hostMatchesScope(rawHost, getScope())) {
                this.ignoredCount++;
                this.ignoredFiles.push(url);
                if (!this.ignoredDomains.includes(rawHost)) {
                    this.ignoredDomains.push(rawHost);
                }
                return;
            }

            let res;
            try {
                res = await makeRequest(url, { reportErrors: !this.compactOutput });
            } catch (err) {
                this.recordFailure("download");
                this.reportError(chalk.red(`[!] Failed to download: ${url} : ${err}`));
                return;
            }

            if (!res) {
                // makeRequest owns the detailed non-compact diagnostic. Compact mode
                // intentionally records only the aggregate failure.
                if (isRequestCancelled()) {
                    this.ignoredCount++;
                } else {
                    this.recordFailure("download");
                }
                return;
            }

            const responseResult = await readDownloadedAssetResponse(url, res);
            if (responseResult.ok === false) {
                this.recordFailure(responseResult.failure);
                const label = responseResult.failure === "invalidResponse" ? "Invalid response" : "Failed to download";
                this.reportError(chalk.red(`[!] ${label}: ${url} : ${responseResult.reason}`));
                return;
            }
            if (isRequestCancelled()) {
                this.ignoredCount++;
                return;
            }

            const rawText = responseResult.body;
            const assetKind = getDownloadedAssetKind(url);
            // .js.map / .mjs.map payloads are JSON — adding a `//` banner would break strict
            // JSON parsing later in the same function (parser: "json").
            const file = assetKind === "json" ? rawText : `// File Source: ${url}\n${rawText}`;

            const filename = getSanitizedAssetFilename(url);

            if (!filename) {
                this.ignoredCount++;
                this.reportWarning(chalk.yellow(`[!] Could not determine filename for URL: ${url}. Skipping.`));
                return;
            }

            const childDir = resolveAssetOutputDirectory(this.output, url, this.alreadyBatchTargetRoot);
            const filePath = path.join(childDir, filename);
            let formatted: string;
            try {
                if (assetKind === "json") {
                    formatted =
                        file.length <= PRETTIER_SIZE_LIMIT ? await prettier.format(file, { parser: "json" }) : file;
                } else if (assetKind === "vue") {
                    formatted =
                        file.length <= PRETTIER_SIZE_LIMIT ? await prettier.format(file, { parser: "vue" }) : file;
                } else {
                    formatted =
                        file.length <= PRETTIER_SIZE_LIMIT ? await prettier.format(file, { parser: "babel" }) : file;
                }
            } catch (formatErr) {
                this.recordFailure("format");
                this.reportError(chalk.red(`[!] Failed to format file: ${filePath} : ${formatErr}`));
                return;
            }

            if (isRequestCancelled()) {
                this.ignoredCount++;
                return;
            }

            try {
                fs.mkdirSync(childDir, { recursive: true });
                fs.writeFileSync(filePath, formatted);
            } catch (writeErr) {
                this.recordFailure("write");
                if (globalsUtil.getVerbose()) {
                    const shortErr = String(writeErr).split("\n")[0];
                    this.reportError(chalk.red(`[!] Failed to write file: ${filePath} : ${shortErr}`));
                }
                return;
            }
            this.downloadCount++;
        } catch (err) {
            this.recordFailure("download");
            this.reportError(chalk.red(`[!] Failed to download: ${url} : ${err}`));
        } finally {
            this.processedCount++;
            this.emitProgress();
        }
    }
}
