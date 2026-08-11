import { Chunks } from "../../utility/interfaces.js";
import { printMsg, MSG } from "../../utility/printMsg.js";
import { createUI } from "./ui.js";
import { setupKeybindings } from "./keybindings.js";
import { enableCursorInput } from "./inputPatch.js";

export interface State {
    chunks: Chunks;
    lastCommandStatus: boolean;
    functionNavHistory: string[];
    functionNavHistoryIndex: number;
    funcWriteFile: string | undefined;
    commandHistory: string[];
    commandHistoryIndex: number;
    writeimports: boolean;
    mapFile: string;
}

type HandleCommandFn = (text: string, state: State, ui: any) => Promise<void>;

/**
 * Build the blessed-backed `interactive()` entry point for a framework, given
 * that framework's `handleCommand` implementation.
 */
function makeInteractive(handleCommand: HandleCommandFn) {
    return async (chunks: Chunks, map_file: string) => {
        const state: State = {
            chunks,
            lastCommandStatus: true,
            functionNavHistory: [],
            functionNavHistoryIndex: -1,
            funcWriteFile: undefined,
            commandHistory: [],
            commandHistoryIndex: -1,
            writeimports: false,
            mapFile: map_file,
        };

        const ui = createUI();

        ui.inputBox.on("submit", async (text: string) => {
            await handleCommand(text, state, ui);
        });

        setupKeybindings(ui.screen, ui.inputBox, ui.outputBox, state);
        enableCursorInput(ui.inputBox);

        ui.inputBox.focus();
        ui.screen.render();
    };
}

/**
 * Build the headless `runCommands()` entry point for a framework, given that
 * framework's `handleCommand` implementation. The blessed UI is replaced by a
 * thin shim that pipes `outputBox.log` to stdout, so a caller (e.g. `map -c
 * ...` or `run -c ...`) can drive the same command surface without a TTY.
 */
function makeRunCommands(handleCommand: HandleCommandFn) {
    return async (chunks: Chunks, map_file: string, commands: string[]): Promise<void> => {
        const state: State = {
            chunks,
            lastCommandStatus: true,
            functionNavHistory: [],
            functionNavHistoryIndex: -1,
            funcWriteFile: undefined,
            commandHistory: [],
            commandHistoryIndex: -1,
            writeimports: false,
            mapFile: map_file,
        };

        const headlessUi: any = {
            screen: { render: () => {} },
            outputBox: { log: (s: string) => printMsg(MSG.Plain, s), setText: () => {} },
            inputBox: { clearValue: () => {}, focus: () => {} },
        };

        for (const command of commands) {
            await handleCommand(command, state, headlessUi);
        }
    };
}

export { makeInteractive, makeRunCommands };
