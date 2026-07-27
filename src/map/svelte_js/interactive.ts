import { createUI } from "../next_js/interactive_helpers/ui.js";
import { handleCommand } from "./interactive_helpers/commandHandler.js";
import { setupKeybindings } from "../next_js/interactive_helpers/keybindings.js";
import { enableCursorInput } from "../next_js/interactive_helpers/inputPatch.js";
import { Chunks } from "../../utility/interfaces.js";
import { printMsg, MSG } from "../../utility/printMsg.js";

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

const interactive = async (chunks: Chunks, map_file: string) => {
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

    setupKeybindings(ui.screen, ui.inputBox, ui.outputBox, state as any);
    enableCursorInput(ui.inputBox);

    ui.inputBox.focus();
    ui.screen.render();
};

const runCommands = async (chunks: Chunks, map_file: string, commands: string[]): Promise<void> => {
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

export { runCommands };
export default interactive;
