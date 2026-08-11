import chalk from "chalk";
import { makeHandleCommand } from "../../interactive-mode/commandHandler.js";
import sharedCommandHelpers from "../../interactive-mode/commandHelpers.js";
import vueCommandHelpers from "./commandHelpers.js";
import { helpMenu } from "./helpMenu.js";

const handleCommand = makeHandleCommand({
    helpMenu,
    handleListOption: (option, parts, state, ui, usage) => {
        const { outputBox } = ui;

        if (option === "all") {
            outputBox.log(sharedCommandHelpers.listAllFunctions(state.chunks));
            state.lastCommandStatus = true;
            return true;
        }
        if (option === "desc") {
            outputBox.log(sharedCommandHelpers.listNonEmptyDescriptionFunctions(state.chunks));
            state.lastCommandStatus = true;
            return true;
        }
        if (option === "nav") {
            outputBox.log(sharedCommandHelpers.navHistory(state.chunks, state.functionNavHistory));
            state.lastCommandStatus = true;
            return true;
        }
        if (option === "files") {
            outputBox.log(vueCommandHelpers.listFiles(state.chunks));
            state.lastCommandStatus = true;
            return true;
        }
        if (option === "file") {
            const fileArg = parts.slice(2).join(" ");
            if (!fileArg) {
                outputBox.log(chalk.magenta(usage));
                state.lastCommandStatus = false;
            } else {
                outputBox.log(vueCommandHelpers.listFunctionsInFile(state.chunks, fileArg));
                state.lastCommandStatus = true;
            }
            return true;
        }
        if (option === "exportnames") {
            const chunkId = parts[2];
            if (!chunkId) {
                outputBox.log(chalk.magenta(usage));
                state.lastCommandStatus = false;
            } else {
                outputBox.log(sharedCommandHelpers.getExportNames(state.chunks, chunkId));
                state.lastCommandStatus = true;
            }
            return true;
        }
        return false;
    },
});

export { handleCommand };
