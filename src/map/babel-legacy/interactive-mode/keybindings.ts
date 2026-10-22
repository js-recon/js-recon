import { Widgets } from "blessed";
import chalk from "chalk";
import { State } from "./interactive.js";

/**
 * Setup keybindings for the interactive mode.
 * @param {Widgets.Screen} screen - The screen object
 * @param {Widgets.TextboxElement} inputBox - The input box element
 * @param {Widgets.Log} outputBox - The output box element
 * @param {State} state - The state object
 */
function setupKeybindings(
    screen: Widgets.Screen,
    inputBox: Widgets.TextboxElement,
    outputBox: Widgets.Log,
    state: State
) {
    // Quit on ctl-c
    screen.key(["C-c", "q"], () => {
        return process.exit(0);
    });

    // on pressing esc on input, focus on output
    inputBox.key(["escape"], () => {
        outputBox.focus();
        outputBox.style.border.fg = "blue";
        inputBox.style.border.fg = "gray";
        screen.render();
    });

    // Clear input box on ctl-c
    inputBox.key(["C-c"], () => {
        const inputBoxValue = inputBox.value;
        outputBox.log(`${state.lastCommandStatus ? chalk.bgGreen("%") : chalk.bgRed("%")} ${inputBoxValue}`);
        outputBox.log(chalk.yellow("^C (Use Esc then C-c to exit)"));
        inputBox.clearValue();
        inputBox.focus();
        state.lastCommandStatus = false;
        screen.render();
    });

    // on pressing 'o' on screen, focus on output box
    screen.key(["o"], () => {
        outputBox.focus();
        outputBox.style.border.fg = "blue";
        inputBox.style.border.fg = "gray";
        screen.render();
    });

    // on pressing 'i' on screen, focus on input box
    screen.key(["i"], () => {
        inputBox.focus();
        inputBox.style.border.fg = "blue";
        outputBox.style.border.fg = "gray";
        screen.render();
    });

    // on pressing arrow keys on output box, scroll the output
    outputBox.key(["up", "down"], (ch: any, key: { name: string }) => {
        outputBox.scroll(key.name === "up" ? -1 : 1);
        screen.render();
    });

    // on pressing arrow keys on input box, navigate through command history
    inputBox.key(["up", "down"], (ch: any, key: { name: string }) => {
        if (key.name === "up") {
            if (state.commandHistoryIndex > 0) {
                state.commandHistoryIndex--;
                inputBox.setValue(state.commandHistory[state.commandHistoryIndex]);
                screen.render();
            } else {
                // blink red
                inputBox.style.border.fg = "red";
                screen.render();
                setTimeout(() => {
                    inputBox.style.border.fg = "blue";
                    screen.render();
                }, 50);
            }
        } else {
            // down
            if (state.commandHistoryIndex < state.commandHistory.length - 1) {
                state.commandHistoryIndex++;
                inputBox.setValue(state.commandHistory[state.commandHistoryIndex]);
                screen.render();
            } else {
                state.commandHistoryIndex = state.commandHistory.length;
                inputBox.setValue("");
                // blink red
                inputBox.style.border.fg = "red";
                screen.render();
                setTimeout(() => {
                    inputBox.style.border.fg = "blue";
                    screen.render();
                }, 50);
            }
        }
    });
}

export { setupKeybindings };
