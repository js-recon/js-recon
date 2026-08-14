import chalk from "chalk";

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
