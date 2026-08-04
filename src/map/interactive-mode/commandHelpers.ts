import chalk from "chalk";
import { Chunks } from "../../utility/interfaces.js";
import { State } from "./interactive.js";
import prettier from "prettier";

const commandHelpers = {
    /**
     * Retrieves the code of a specific function.
     * @param {Chunks} chunks - Collection of code chunks to analyze
     * @param {string} funcName - Name of the function to retrieve code for
     * @param {State} state - State object containing writeimports flag
     * @returns {Promise<string>} - A Promise that resolves to the code of the specified function
     */
    getFunctionCode: async (chunks: Chunks, funcName: string, state: State) => {
        let funcCode: string;
        for (const chunk of Object.values(chunks)) {
            if (chunk.id == funcName) {
                funcCode = chunk.code;
            }
        }

        if (state.writeimports === true) {
            // get the imports one by one, and append it to funcCode

            if (chunks[funcName].imports.length > 0) {
                funcCode += "\n\n// Imports:\n\n";
                for (const importName of chunks[funcName].imports) {
                    // append the description as docstring
                    // and the code for the function
                    funcCode += `/**\n* ${chunks[importName].description}\n*/\n${chunks[importName].code}`;
                }
            }
        }

        // beautify the code
        funcCode = await prettier.format(funcCode, { parser: "babel" });

        if (!funcCode) {
            return chalk.red(`Function ${funcName} not found`);
        }
        return funcCode;
    },
    /**
     * Lists all functions in the code chunks.
     * @param {Chunks} chunks - Collection of code chunks to analyze
     * @returns {string} - A string containing the list of all functions
     */
    listAllFunctions: (chunks: Chunks) => {
        let returnText = chalk.cyan("List of all functions\n");
        for (const chunk of Object.values(chunks)) {
            returnText += chalk.green(`- ${chunk.id}: ${chunk.description} (${chunk.file})\n`);
        }
        return returnText;
    },
    /**
     * Retrieves the navigation history.
     * @param {Chunks} chunks - Collection of code chunks to analyze
     * @param {string[]} navList - List of function IDs in navigation history
     * @returns {string} - A string containing the navigation history
     */
    navHistory: (chunks: Chunks, navList: string[]): string => {
        let returnText = chalk.cyan("Navigation history\n");
        if (navList.length === 0) {
            returnText += chalk.yellow("- No navigation history");
        } else {
            for (const id of navList) {
                if (Object.keys(chunks).includes(id)) {
                    returnText += chalk.green(`- ${id}: ${chunks[id].description}\n`);
                } else {
                    returnText += chalk.yellow(`- ${id}: <function not found>\n`);
                }
            }
        }
        return returnText;
    },
    /**
     * Traces a specific function.
     * @param {Chunks} chunks - Collection of code chunks to analyze
     * @param {string} funcName - Name of the function to trace
     * @returns {string} - A string containing the trace of the specified function
     */
    traceFunction: (chunks: Chunks, funcName: string) => {
        let returnText = chalk.cyan(`Tracing function ${funcName}\n`);
        const thisChunk = chunks[funcName];
        if (!thisChunk) {
            returnText += chalk.red(`Function ${funcName} not found`);
        } else {
            // get imports
            if (thisChunk.imports.length === 0) {
                returnText += chalk.yellow("- No imports");
            } else {
                returnText += chalk.greenBright("Imports:\n");
                for (const importName of thisChunk.imports) {
                    const funcDesc = chunks[importName].description;
                    returnText += chalk.green(`- ${importName}: ${funcDesc}\n`);
                }
            }

            returnText += "\n";
            // get functions which import this particular function
            // iterate over the function
            let exported_to_chunks = [];
            for (const chunk of Object.values(chunks)) {
                // get the imports
                const chunk_imports = chunk.imports;

                // see if the import includes this particular ID
                for (const chunk_import of chunk_imports) {
                    // if so, then push to the var
                    if (chunk_import == funcName) {
                        exported_to_chunks.push(chunk.id);
                    }
                }
            }

            // append to return text
            if (exported_to_chunks.length === 0) {
                returnText += chalk.yellow("- No exports");
            } else {
                returnText += chalk.greenBright("Exports:\n");
                for (const exportName of exported_to_chunks) {
                    returnText += chalk.green(`- ${exportName}: ${chunks[exportName].description}\n`);
                }
            }
        }
        return returnText;
    },
    getExportNames: (chunks: Chunks, chunkId: string): string => {
        // check if the chunk exists
        if (!chunks[chunkId] && chunkId !== "all" && chunkId !== "nonempty") {
            return chalk.red(`Chunk ${chunkId} not found`);
        }

        let returnText = chalk.cyan("List of export names\n");

        if (chunkId === "all") {
            returnText += "\n";
            returnText += chalk.magenta("Listing all chunks:\n");
            for (const chunk of Object.keys(chunks)) {
                returnText += chalk.green(`- ${chunk}: ${chunks[chunk].description}\n`);
                for (const exportName of chunks[chunk].exports) {
                    returnText += chalk.green(`  - ${exportName}\n`);
                }
            }
        } else if (chunkId === "nonempty") {
            returnText += "\n";
            returnText += chalk.magenta("Listing all chunks:\n");
            for (const chunk of Object.keys(chunks)) {
                if (chunks[chunk].exports.length > 0) {
                    returnText += chalk.green(`- ${chunk}: ${chunks[chunk].description}\n`);
                    for (const exportName of chunks[chunk].exports) {
                        returnText += chalk.green(`  - ${exportName}\n`);
                    }
                }
            }
        } else {
            // check if it is empty
            if (chunks[chunkId].exports.length === 0) {
                returnText += chalk.yellow("- No exports");
            } else {
                for (const exportName of chunks[chunkId].exports) {
                    returnText += chalk.green(`- ${exportName}\n`);
                }
            }
        }
        return returnText;
    },
    listNonEmptyDescriptionFunctions: (chunks: Chunks) => {
        let returnText = chalk.cyan("List of functions with non-empty descriptions\n");
        let count = 0;
        for (const chunk of Object.values(chunks)) {
            if (chunk.description !== "none") {
                returnText += chalk.green(`- ${chunk.id}: ${chunk.description}\n`);
                count++;
            }
        }
        if (count === 0) {
            returnText += chalk.yellow("- No functions with non-empty descriptions");
        }
        return returnText;
    },
};

export default commandHelpers;
