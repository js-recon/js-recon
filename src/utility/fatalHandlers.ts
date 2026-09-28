import chalk from "chalk";

// Browser closes started by cancellation (e.g. lazyload's framework-detection timeout).
// puppeteer-extra-plugin-stealth's user-agent-override evasion sends
// `Network.setUserAgentOverride` without awaiting it, so closing a browser while a page is
// still being set up orphans a TargetCloseError that no caller can catch. While a
// cancellation-owned close is in flight (plus a grace window for the rejection to surface),
// that error is expected, not fatal. Any other rejection still exits 34.
let cancellationCloses = 0;
const CANCELLATION_CLOSE_GRACE_MS = 1_000;

/** Closes a browser on behalf of cancellation; never rejects. */
export const closeForCancellation = async (close: () => Promise<unknown>): Promise<void> => {
    cancellationCloses++;
    try {
        await close();
    } catch {
        // already closed/disconnected
    } finally {
        setTimeout(() => cancellationCloses--, CANCELLATION_CLOSE_GRACE_MS).unref();
    }
};

/**
 * Safety net: `runSandboxed.ts`'s `lockdown()` (SES) installs a log-only
 * `process.on('unhandledRejection', ...)` handler as a side effect of import, which disables
 * Node's default crash-on-unhandled-rejection behavior tool-wide (not just for sandboxed code).
 * Node invokes every registered listener for an event, so this handler still fires alongside
 * SES's and is what actually turns an orphaned rejection into a real non-zero exit instead of a
 * silent exit 0.
 */
export const registerFatalHandlers = (): (() => void) => {
    // Passed as a separate console.error argument rather than interpolated into the template
    // literal — reason/error can be a Symbol, and Symbol-to-string coercion throws, which would
    // crash this handler itself before process.exit(34) runs.
    const onUnhandledRejection = (reason: unknown) => {
        if (cancellationCloses > 0 && (reason as Error | null)?.name === "TargetCloseError") return;
        console.error(chalk.red("[!] Unhandled promise rejection:"), reason);
        process.exit(34);
    };
    const onUncaughtException = (error: unknown) => {
        console.error(chalk.red("[!] Uncaught exception:"), error);
        process.exit(34);
    };

    process.on("unhandledRejection", onUnhandledRejection);
    process.on("uncaughtException", onUncaughtException);

    return () => {
        process.off("unhandledRejection", onUnhandledRejection);
        process.off("uncaughtException", onUncaughtException);
    };
};
