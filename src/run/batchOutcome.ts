/**
 * Exit code of a batch run (`run -u <file>`) that processed every target but
 * where at least one target failed. The targets that succeeded wrote their
 * output and were merged into the batch's js-recon.db, so a caller can keep
 * them instead of discarding the whole run as it would on exit code 1.
 */
export const BATCH_PARTIAL_FAILURE_EXIT_CODE = 36;

/**
 * Returns the exit code for a batch run that reached its last target: 0 when
 * every target succeeded, BATCH_PARTIAL_FAILURE_EXIT_CODE when only some
 * failed, and 1 when every target failed.
 */
export const batchExitCode = (failedTargets: number, totalTargets: number): number => {
    if (failedTargets <= 0) return 0;
    return failedTargets >= totalTargets ? 1 : BATCH_PARTIAL_FAILURE_EXIT_CODE;
};

/**
 * The line a batch run prints after its last target when some targets
 * failed, so a caller can read the outcome from the end of the log.
 */
export const batchFailureSummary = (failedTargets: number, totalTargets: number): string =>
    `[!] Batch completed: ${failedTargets} of ${totalTargets} targets failed`;
