import chalk from "chalk";
import { Chunks } from "../../../utility/interfaces.js";
import { getOpenapiOutput } from "../../../utility/globals.js";

const commandHelpers = {
    /**
     * Lists chunks that contain fetch instances.
     * @param {Chunks} chunks - Collection of code chunks to analyze
     * @returns {string} - A string containing the list of chunks with fetch instances
     */
    fetchMenu: (chunks: Chunks) => {
        let returnText = chalk.cyan("List of chunks that contain fetch instances\n");
        for (const chunk of Object.values(chunks)) {
            if (chunk.containsFetch) {
                returnText += chalk.green(`- ${chunk.id}: ${chunk.file} (${chunk.description})\n`);
            }
        }
        return returnText;
    },
    /**
     * Lists chunks that are axios clients.
     * @param {Chunks} chunks - Collection of code chunks to analyze
     * @returns {string} - A string containing the list of chunks that are axios clients
     */
    axiosClientsMenu: (chunks: Chunks) => {
        let returnText = chalk.cyan("List of chunks that are axios clients\n");
        for (const chunk of Object.values(chunks)) {
            if (chunk.isAxiosLibrary) {
                returnText += chalk.green(`- ${chunk.id}: ${chunk.file} (${chunk.description})\n`);
            }
        }
        return returnText;
    },
    listServerActions: () => {
        const items = getOpenapiOutput().filter((item) => item.headers?.["next-action"]);
        if (items.length === 0) {
            return chalk.yellow("No Server Actions discovered.");
        }
        let returnText = chalk.cyan(`Server Actions (${items.length})\n`);
        for (const item of items) {
            const actionId = item.headers["next-action"];
            const name = item.summary ?? actionId;
            returnText += chalk.green(`\n${name}`);
            returnText += chalk.gray(` (${actionId})`);
            returnText += `\n  Route:  ${chalk.white(item.path)}`;
            returnText += `\n  Chunk:  ${chalk.white(item.chunkId)}`;
            if (item.functionFile) {
                returnText += `\n  Def:    ${chalk.white(`${item.functionFile}:${item.functionFileLine}`)}`;
            }
            if (item.serverActionCallFile) {
                returnText += `\n  Args:   ${chalk.white(`${item.serverActionCallFile}:${item.serverActionCallLine}`)}`;
            }
            if (item.body) {
                returnText += `\n  Body:   ${chalk.yellow(item.body)}`;
            }
            returnText += "\n";
        }
        return returnText;
    },
};

export default commandHelpers;
