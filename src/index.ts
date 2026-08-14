#!/usr/bin/env node
import chalk from "chalk";
import { buildProgram } from "./cliProgram.js";
import { printBanner } from "./utility/banner.js";
import { ApplicationConfigError } from "./config/applicationConfig.js";
import { OxylabsFallbackConfigurationError } from "./proxy/oxylabsFallback.js";
import { TargetInputError } from "./utility/targetInputs.js";
import { RunOutputDirectoryError } from "./run/outputDirectory.js";

// Safety net: `src/utility/runSandboxed.ts`'s `lockdown()` (SES) installs a log-only
// `process.on('unhandledRejection', ...)` handler as a side effect of import, which disables
// Node's default crash-on-unhandled-rejection behavior tool-wide (not just for sandboxed code).
// Node invokes every registered listener for an event, so this handler still fires alongside
// SES's and is what actually turns an orphaned rejection into a real non-zero exit instead of a
// silent exit 0.
process.on("unhandledRejection", (reason) => {
    console.error(chalk.red(`[!] Unhandled promise rejection: ${reason}`));
    process.exit(34);
});
process.on("uncaughtException", (error) => {
    console.error(chalk.red(`[!] Uncaught exception: ${error}`));
    process.exit(34);
});

const args = process.argv.slice(2);
const isVersionFlag = args.length === 1 && (args[0] === "-V" || args[0] === "--version");
const isCompletionCmd = args[0] === "completion";
if (!isVersionFlag && !isCompletionCmd) {
    await (async () => printBanner())();
}

/**
 * Main CLI application entry point for js-recon tool.
 * Sets up command-line interface with various modules for JavaScript reconnaissance.
 */
try {
    const program = buildProgram();
    await (async () => program.parseAsync(process.argv))();
} catch (error) {
    if (
        error instanceof ApplicationConfigError ||
        error instanceof OxylabsFallbackConfigurationError ||
        error instanceof TargetInputError ||
        error instanceof RunOutputDirectoryError
    ) {
        console.error(chalk.red(`[!] ${error.message}`));
        process.exitCode = 1;
    } else {
        throw error;
    }
}
