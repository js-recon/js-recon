import chalk from "chalk";
import path from "path";
import fs from "fs";
import prettier from "prettier";
import makeRequest from "../utility/makeReq.js";
import { getURLDirectory, getFilenameFromUrl } from "../utility/urlUtils.js";
import { getScope } from "./globals.js";
import { progressLog, progressError, progressWarn } from "../utility/progressLog.js";
import * as globalsUtil from "../utility/globals.js";

export interface DownloadQueueOptions {
    /** Called after each URL is processed (downloaded, ignored, or failed). */
    onProgress?: (processed: number, total: number, downloaded: number) => void;
}

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
    private ignoredFiles: string[] = [];
    private ignoredDomains: string[] = [];

    private readonly onProgress?: DownloadQueueOptions["onProgress"];

    constructor(output: string, concurrency: number, options: DownloadQueueOptions = {}) {
        this.output = output;
        this.concurrency = Math.max(1, concurrency);
        this.onProgress = options.onProgress;
        fs.mkdirSync(output, { recursive: true });
    }

    get totalEnqueued(): number {
        return this.seen.size;
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

    private spawnWorkers(): void {
        while (this.activeWorkers < this.concurrency && this.pending.length > 0) {
            this.activeWorkers++;
            this.runWorker();
        }
    }

    private async runWorker(): Promise<void> {
        while (this.pending.length > 0) {
            const url = this.pending.shift()!;
            await this.processOne(url);
        }
        this.activeWorkers--;
        if (this.activeWorkers === 0 && this.pending.length === 0) {
            const callbacks = this.drainCallbacks.splice(0);
            for (const cb of callbacks) cb();
        }
    }

    private async processOne(url: string): Promise<void> {
        try {
            if (
                !url.match(/(\.mjs\.map|\.mjs|\.js|\.json|\.js\.map|\.vue)/) ||
                url.match(/lang\.(css|scss|sass|less|styl)/)
            ) {
                progressLog(chalk.yellow(`[i] Ignored ${url}`));
                return;
            }

            const { host, directory } = getURLDirectory(url);

            if (!getScope().includes("*") && !getScope().includes(host)) {
                this.ignoredFiles.push(url);
                if (!this.ignoredDomains.includes(host)) {
                    this.ignoredDomains.push(host);
                }
                return;
            }

            const childDir = path.join(this.output, host, directory);
            fs.mkdirSync(childDir, { recursive: true });

            let res;
            try {
                res = await makeRequest(url, {});
            } catch {
                progressError(chalk.red(`[!] Failed to download: ${url}`));
                return;
            }

            if (!res) {
                progressError(chalk.red(`[!] Failed to download: ${url}`));
                return;
            }

            const rawText = await res.text();
            // .js.map / .mjs.map payloads are JSON — adding a `//` banner would break strict
            // JSON parsing later in the same function (parser: "json").
            const file =
                url.match(/\.json/) || url.match(/\.m?js\.map/) ? rawText : `// File Source: ${url}\n${rawText}`;

            const filename = getFilenameFromUrl(url);

            if (!filename) {
                progressWarn(chalk.yellow(`[!] Could not determine filename for URL: ${url}. Skipping.`));
                return;
            }

            const filePath = path.join(childDir, filename);
            try {
                if (url.match(/\.json/) || url.match(/\.m?js\.map/)) {
                    const formatted =
                        file.length <= PRETTIER_SIZE_LIMIT ? await prettier.format(file, { parser: "json" }) : file;
                    fs.writeFileSync(filePath, formatted);
                } else if (url.match(/\.vue$/)) {
                    const formatted =
                        file.length <= PRETTIER_SIZE_LIMIT ? await prettier.format(file, { parser: "vue" }) : file;
                    fs.writeFileSync(filePath, formatted);
                } else {
                    const formatted =
                        file.length <= PRETTIER_SIZE_LIMIT ? await prettier.format(file, { parser: "babel" }) : file;
                    fs.writeFileSync(filePath, formatted);
                }
            } catch (writeErr) {
                if (globalsUtil.getVerbose()) {
                    const shortErr = String(writeErr).split("\n")[0];
                    progressError(chalk.red(`[!] Failed to write file: ${filePath} : ${shortErr}`));
                }
                return;
            }
            this.downloadCount++;
        } catch (err) {
            progressError(chalk.red(`[!] Failed to download: ${url} : ${err}`));
        } finally {
            this.processedCount++;
            this.onProgress?.(this.processedCount, this.seen.size, this.downloadCount);
        }
    }
}
