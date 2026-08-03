/**
 * Runs an interruptible step without abandoning its work promise. If a skip
 * request wins the race, the step receives an abort signal and this function
 * still waits for its cleanup boundary before returning to the pipeline.
 */
export const awaitCancellableStep = async (
    work: (signal: AbortSignal) => Promise<void>,
    cancellationRequested: Promise<void>
): Promise<void> => {
    const controller = new AbortController();
    let cancellationWon = false;
    const workPromise = work(controller.signal);
    const cancellationPromise = cancellationRequested.then(() => {
        cancellationWon = true;
        controller.abort();
    });

    await Promise.race([workPromise, cancellationPromise]);
    if (cancellationWon) await workPromise;
};
