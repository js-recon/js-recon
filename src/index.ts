#!/usr/bin/env node
import chalk from "chalk";
import { buildProgram } from "./cliProgram.js";
import { printBanner } from "./utility/banner.js";
import { ApplicationConfigError } from "./config/applicationConfig.js";
import { OxylabsFallbackConfigurationError } from "./proxy/oxylabsFallback.js";
import { TargetInputError } from "./utility/targetInputs.js";
import { RunOutputDirectoryError } from "./run/outputDirectory.js";

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
