import chalk from "chalk";
import { makeHandleCommand } from "../../interactive-mode/commandHandler.js";
import sharedCommandHelpers from "../../interactive-mode/commandHelpers.js";
import commandHelpers from "./commandHelpers.js";
import { helpMenu } from "./helpMenu.js";

const handleCommand = makeHandleCommand({
    helpMenu,
    handleListOption: (option, parts, state, ui, usage) => {
        const { outputBox } = ui;

        if (option === "fetch") {
            outputBox.log(commandHelpers.fetchMenu(state.chunks));
            state.lastCommandStatus = true;
            return true;
        }
        if (option === "axios") {
            outputBox.log(commandHelpers.axiosClientsMenu(state.chunks));
            state.lastCommandStatus = true;
            return true;
        }
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
        if (option === "server_actions") {
            outputBox.log(commandHelpers.listServerActions());
            state.lastCommandStatus = true;
            return true;
        }
        if (option === "exportnames") {
            // get the chunk id
            const chunkId = parts[2];
            if (chunkId === "") {
                outputBox.log(chalk.magenta(usage));
                state.lastCommandStatus = false;
            } else {
                const exportNames = sharedCommandHelpers.getExportNames(state.chunks, chunkId);
                outputBox.log(exportNames);
                state.lastCommandStatus = true;
            }
            return true;
        }
        return false;
    },
});

export { handleCommand };
