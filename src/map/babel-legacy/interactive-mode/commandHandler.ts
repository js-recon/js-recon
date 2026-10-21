import chalk from "chalk";
import path from "path";
import fs from "fs";
import { Widgets } from "blessed";
import { State } from "./interactive.js";
import commandHelpers from "./commandHelpers.js";
import { printFunction } from "./printer.js";
import { runEsqueryCommand } from "./esqueryGen.js";

interface Screen {
    screen: any;
    titleBox?: Widgets.BoxElement;
    outputBox: Widgets.Log;
    inputBox: Widgets.TextboxElement;
}

/**
 * Per-framework `list <option>` sub-dispatch. Returns `true` if the option
 * was recognized and handled (setting `state.lastCommandStatus` itself);
 * returns `false` to fall through to the shared "not a valid option" path.
 */
type ListOptionHandler = (option: string, parts: string[], state: State, ui: Screen, usage: string) => boolean;

interface CommandHandlerDeps {
    helpMenu: Record<string, string>;
    handleListOption: ListOptionHandler;
}

/**
 * Build a framework's `handleCommand` implementation. All dispatch logic
 * (help/exit/clear/go/set/esquery/trace/invalid-command) is shared here;
 * only the `list <option>` sub-dispatch is framework-specific and supplied
 * via `deps.handleListOption`.
 */
function makeHandleCommand(deps: CommandHandlerDeps) {
    const { helpMenu, handleListOption } = deps;

    return async function handleCommand(text: string, state: State, ui: Screen) {
        const { outputBox, inputBox, screen } = ui;

        if (text !== "" && !text.match(/^\s+$/) && text !== state.commandHistory[state.commandHistory.length - 1]) {
            state.commandHistory.push(text);
            state.commandHistoryIndex = state.commandHistory.length;
        }
        if (state.lastCommandStatus) {
            outputBox.log(`${chalk.bgGreenBright("%")} ${text}`);
        } else {
            outputBox.log(`${chalk.bgRed("%")} ${text}`);
        }

        if (text === "") {
            state.lastCommandStatus = true;
        } else if (text === "exit") {
            return process.exit(0);
        } else if (text === "help") {
            let helpText = chalk.cyan("Available commands:\n");
            for (const [key, value] of Object.entries(helpMenu)) {
                helpText += chalk.green(`\n${key}:\n`);
                helpText += `  ${value.replace(/\n/g, "\n  ")}\n`;
            }
            outputBox.log(helpText);
            state.lastCommandStatus = true;
        } else if (text.startsWith("list")) {
            const usage = helpMenu.list;
            const parts = text.split(" ");
            if (parts.length < 2) {
                outputBox.log(chalk.magenta(usage));
                state.lastCommandStatus = false;
            } else {
                const option = parts[1];

                if (option === "") {
                    outputBox.log(chalk.magenta(usage));
                    state.lastCommandStatus = false;
                } else if (!handleListOption(option, parts, state, ui, usage)) {
                    outputBox.log(chalk.red(option) + " is not a valid option");
                    state.lastCommandStatus = false;
                }
            }
        } else if (text.startsWith("go")) {
            const usage = helpMenu.go;
            const parts = text.split(" ");
            if (parts.length < 2) {
                outputBox.log(chalk.magenta(usage));
                state.lastCommandStatus = false;
            } else {
                const funcName = parts[1];
                if (funcName === "") {
                    outputBox.log(chalk.magenta(usage));
                    state.lastCommandStatus = false;
                } else if (funcName === "to") {
                    const funcId = parts[2];
                    // check if the function exists
                    if (state.chunks[funcId]) {
                        const funcCode = await commandHelpers.getFunctionCode(state.chunks, funcId, state);
                        printFunction(outputBox, funcCode, state.chunks[funcId]?.description, state.funcWriteFile);
                        state.lastCommandStatus = true;
                    } else {
                        outputBox.log(chalk.red(`No function with ID ${funcId} found`));
                        state.lastCommandStatus = false;
                    }

                    // before pushing to the function nav history,
                    // make sure this is not the same as the last one
                    if (
                        state.functionNavHistory[state.functionNavHistoryIndex] !== funcId &&
                        Object.keys(state.chunks).includes(funcId)
                    ) {
                        state.functionNavHistory.push(funcId);
                        state.functionNavHistoryIndex++;
                    }
                } else if (funcName === "back") {
                    if (state.functionNavHistory.length > 0) {
                        if (state.functionNavHistoryIndex > 0) {
                            state.functionNavHistoryIndex--;
                            const funcId = state.functionNavHistory[state.functionNavHistoryIndex];

                            if (Object.keys(state.chunks).includes(funcId)) {
                                const funcCode = await commandHelpers.getFunctionCode(state.chunks, funcId, state);
                                printFunction(
                                    outputBox,
                                    funcCode,
                                    state.chunks[funcId].description,
                                    state.funcWriteFile
                                );
                                state.lastCommandStatus = true;
                            } else {
                                outputBox.log(chalk.red(`No function with ID ${funcId} found`));
                                state.lastCommandStatus = false;
                            }
                        } else {
                            outputBox.log(chalk.red("No previous function found"));
                            state.lastCommandStatus = false;
                        }
                    } else {
                        outputBox.log(chalk.red("No previous function found"));
                        state.lastCommandStatus = false;
                    }
                } else if (funcName === "ahead") {
                    if (state.functionNavHistory.length > 0) {
                        if (state.functionNavHistoryIndex < state.functionNavHistory.length - 1) {
                            state.functionNavHistoryIndex++;
                            const funcId = state.functionNavHistory[state.functionNavHistoryIndex];
                            if (Object.keys(state.chunks).includes(funcId)) {
                                const funcCode = await commandHelpers.getFunctionCode(state.chunks, funcId, state);
                                printFunction(
                                    outputBox,
                                    funcCode,
                                    state.chunks[funcId].description,
                                    state.funcWriteFile
                                );
                                state.lastCommandStatus = true;
                            } else {
                                outputBox.log(chalk.red(`No function with ID ${funcId} found`));
                                state.lastCommandStatus = false;
                            }
                        } else {
                            outputBox.log(chalk.red("No next function found"));
                            state.lastCommandStatus = false;
                        }
                    } else {
                        outputBox.log(chalk.red("No next function found"));
                        state.lastCommandStatus = false;
                    }
                } else {
                    outputBox.log(chalk.red(funcName) + " is not a valid option");
                    state.lastCommandStatus = false;
                }
            }
        } else if (text === "clear") {
            outputBox.setText("");
            state.lastCommandStatus = true;
        } else if (text.startsWith("set")) {
            const parts = text.split(" ");
            if (parts.length < 3) {
                outputBox.log(chalk.magenta(helpMenu.set));
                state.lastCommandStatus = false;
            } else {
                const option = parts[1];
                if (option === "funcwritefile") {
                    const fileName = parts[2];
                    state.funcWriteFile = path.join(`${fileName}`);
                    outputBox.log(chalk.green(`Function write file set to ${state.funcWriteFile}`));
                    state.lastCommandStatus = true;
                } else if (option === "writeimports") {
                    // modify the var in state
                    const modifyVal = parts[2];
                    if (modifyVal === "true") {
                        state.writeimports = true;
                        outputBox.log("writeimports: " + chalk.green("true"));
                        state.lastCommandStatus = true;
                    } else if (modifyVal === "false") {
                        state.writeimports = false;
                        outputBox.log("writeimports: " + chalk.yellow("false"));
                        state.lastCommandStatus = true;
                    } else {
                        outputBox.log(chalk.magenta(helpMenu.set));
                        state.lastCommandStatus = false;
                    }
                } else if (option === "funcdesc") {
                    // update the function description
                    const chunkId = parts[2];

                    if (!chunkId) {
                        outputBox.log(chalk.magenta(helpMenu.set));
                        state.lastCommandStatus = false;
                    } else {
                        // check if the function id exists or not
                        if (!Object.keys(state.chunks).includes(chunkId)) {
                            outputBox.log(chalk.red(`Chunk ID ${chunkId} not found`));
                            state.lastCommandStatus = false;
                        } else {
                            // proceed with modifying chunk name
                            const newChunkDesc = parts.slice(3).join(" ");
                            state.chunks[chunkId].description = newChunkDesc;

                            // write to file also
                            fs.writeFileSync(state.mapFile, JSON.stringify(state.chunks, null, 2));

                            outputBox.log(chalk.green(`Description for ${chunkId} modified: ${newChunkDesc}`));

                            state.lastCommandStatus = true;
                        }
                    }
                } else {
                    outputBox.log(chalk.red(option) + " is not a valid option");
                    state.lastCommandStatus = false;
                }
            }
        } else if (text.startsWith("esquery")) {
            const usage = helpMenu.esquery;
            const parts = text.split(" ");
            if (parts.length < 3) {
                outputBox.log(chalk.magenta(usage));
                state.lastCommandStatus = false;
            } else {
                const chunkId = parts[1];
                const search = parts.slice(2).join(" ");
                try {
                    const result = runEsqueryCommand(state.chunks, chunkId, search);
                    outputBox.log(result);
                    state.lastCommandStatus = true;
                } catch (err) {
                    outputBox.log(chalk.red(err instanceof Error ? err.message : String(err)));
                    state.lastCommandStatus = false;
                }
            }
        } else if (text.startsWith("trace")) {
            const usage = helpMenu.trace;
            const parts = text.split(" ");
            if (parts.length < 2) {
                outputBox.log(chalk.magenta(usage));
                state.lastCommandStatus = false;
            } else {
                const funcName = parts[1];
                if (!funcName) {
                    outputBox.log(chalk.magenta(usage));
                    state.lastCommandStatus = false;
                } else {
                    outputBox.log(commandHelpers.traceFunction(state.chunks, funcName));
                    state.lastCommandStatus = true;
                }
            }
        } else {
            outputBox.log((chalk.red(text), "is not a valid command"));
            state.lastCommandStatus = false;
        }
        inputBox.clearValue();
        inputBox.focus();
        screen.render();
    };
}

export { makeHandleCommand };
export type { CommandHandlerDeps, ListOptionHandler, Screen };
