import chalk from "chalk";
import cliProgress from "cli-progress";
import vue_discoverJsFiles from "./vue_discoverJsFiles.js";
import { setActiveBarLogger, computeBarSize, watchBarResize } from "../../utility/progressLog.js";
import type { TechniqueRecorder } from "../researchUtils.js";
import { printMsg, MSG } from "../../utility/printMsg.js";

/**
 * Recursively walks newly discovered Vue.js client-side paths.
 *
 * For each path, runs the same discovery pipeline used on the entry URL
 * (via {@link vue_discoverJsFiles}), collects every JS file it finds and
 * queues any new client-side paths surfaced from those files. Paths are
 * tracked in a visited set so each URL is only processed once.
 *
 * Termination conditions:
 *   - the pending queue is exhausted, or
 *   - {@link STAGNATION_LIMIT} consecutive rounds yield no new JS files.
 */
const STAGNATION_LIMIT = 3;

const vue_recursiveClientSidePathDownload = async (
    clientSidePaths: string[],
    threads: number = 1,
    maxJsSizeMb: number = 2,
    onFilesDiscovered?: (files: string[]) => void,
    includeMethods: string[] = [],
    excludeMethods: string[] = [],
    onTechnique?: TechniqueRecorder
): Promise<string[]> => {
    const allJsFiles = new Set<string>();
    const visitedPaths = new Set<string>();
    const knownPaths = new Set<string>();
    let pending: string[] = [];

    for (const p of clientSidePaths) {
        if (!knownPaths.has(p)) {
            knownPaths.add(p);
            pending.push(p);
        }
    }

    let stagnantRounds = 0;
    let round = 0;

    if (pending.length === 0) {
        return [];
    }

    const bar = new cliProgress.SingleBar(
        {
            format:
                chalk.cyan("[i] Recursing client-side paths ") +
                "[{bar}] {percentage}% | {value}/{total} paths | round {round} | {jsFiles} JS files | {stagnant} stagnant",
            barCompleteChar: "█",
            barIncompleteChar: "░",
            barsize: computeBarSize(99),
            hideCursor: false,
            clearOnComplete: false,
            stopOnComplete: false,
            etaBuffer: 50,
        },
        cliProgress.Presets.shades_classic
    );

    bar.start(knownPaths.size, 0, {
        round: 0,
        jsFiles: 0,
        stagnant: `0/${STAGNATION_LIMIT}`,
    });
    const stopBarWatcher = watchBarResize(bar, 99);
    setActiveBarLogger({ log: (s: string) => process.stdout.write("\r\x1b[K" + s) });

    const refreshBar = () => {
        bar.setTotal(knownPaths.size);
        bar.update(visitedPaths.size, {
            round,
            jsFiles: allJsFiles.size,
            stagnant: `${stagnantRounds}/${STAGNATION_LIMIT}`,
        });
    };

    try {
        while (pending.length > 0) {
            const batch = pending.filter((p) => !visitedPaths.has(p));
            pending = [];

            if (batch.length === 0) break;

            round++;
            const sizeBeforeRound = allJsFiles.size;

            const errors: string[] = [];
            let cursor = 0;
            const workerCount = Math.max(1, Math.min(threads, batch.length));

            const worker = async () => {
                while (cursor < batch.length) {
                    const path = batch[cursor++];
                    try {
                        const { jsFiles, clientSidePaths: newPaths } = await vue_discoverJsFiles(
                            path,
                            maxJsSizeMb,
                            onFilesDiscovered,
                            includeMethods,
                            excludeMethods,
                            onTechnique
                        );

                        for (const file of jsFiles) {
                            allJsFiles.add(file);
                        }

                        for (const newPath of newPaths) {
                            if (!knownPaths.has(newPath)) {
                                knownPaths.add(newPath);
                                pending.push(newPath);
                            }
                        }
                    } catch (err) {
                        errors.push(
                            `[!] Failed to recurse into ${path}: ${err instanceof Error ? err.message : String(err)}`
                        );
                    } finally {
                        visitedPaths.add(path);
                        refreshBar();
                    }
                }
            };

            await Promise.all(Array.from({ length: workerCount }, () => worker()));

            if (errors.length > 0) {
                bar.stop();
                for (const msg of errors) {
                    printMsg(MSG.Err, msg);
                }
                bar.start(knownPaths.size, visitedPaths.size, {
                    round,
                    jsFiles: allJsFiles.size,
                    stagnant: `${stagnantRounds}/${STAGNATION_LIMIT}`,
                });
            }

            const newFilesThisRound = allJsFiles.size - sizeBeforeRound;
            if (newFilesThisRound === 0) {
                stagnantRounds++;
                refreshBar();
                if (stagnantRounds >= STAGNATION_LIMIT) {
                    bar.stop();
                    printMsg(
                        MSG.Warn,
                        `[!] Stopping recursion: ${STAGNATION_LIMIT} consecutive rounds without new JS files`
                    );
                    break;
                }
            } else {
                stagnantRounds = 0;
            }
        }
    } finally {
        bar.stop();
        stopBarWatcher();
        setActiveBarLogger(null);
    }

    if (allJsFiles.size > 0) {
        printMsg(
            MSG.Run,
            `[✓] Recursive client-side discovery yielded ${allJsFiles.size} JS file(s) across ${visitedPaths.size} path(s)`
        );
    }

    return [...allJsFiles];
};

export default vue_recursiveClientSidePathDownload;
