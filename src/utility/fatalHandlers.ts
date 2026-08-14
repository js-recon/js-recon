import chalk from "chalk";

/**
 * Safety net: `runSandboxed.ts`'s `lockdown()` (SES) installs a log-only
 * `process.on('unhandledRejection', ...)` handler as a side effect of import, which disables
 * Node's default crash-on-unhandled-rejection behavior tool-wide (not just for sandboxed code).
 * Node invokes every registered listener for an event, so this handler still fires alongside
 * SES's and is what actually turns an orphaned rejection into a real non-zero exit instead of a
 * silent exit 0.
 */
export const registerFatalHandlers = (): void => {
    process.on("unhandledRejection", (reason) => {
        console.error(chalk.red(`[!] Unhandled promise rejection: ${reason}`));
        process.exit(34);
    });
    process.on("uncaughtException", (error) => {
        console.error(chalk.red(`[!] Uncaught exception: ${error}`));
        process.exit(34);
    });
};
