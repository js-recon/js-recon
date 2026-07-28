#!/usr/bin/env node
import { buildProgram } from "./cliProgram.js";
import { printBanner } from "./utility/banner.js";

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
const program = buildProgram();

program.parse(process.argv);
