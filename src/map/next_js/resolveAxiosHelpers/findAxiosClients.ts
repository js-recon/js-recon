import { Chunks } from "../../../utility/interfaces.js";
import { printMsg, MSG } from "../../../utility/printMsg.js";

/**
 * Finds the chunks that export and import Axios clients.
 * @param {Chunks} chunks - Collection of code chunks to analyze
 * @returns {{axiosExportedFrom: string[], axiosImportedTo: { [key: string]: string }}
 *      - an object containing two properties: axiosExportedFrom and axiosImportedTo.
 *      - axiosExportedFrom is an array of chunk names that have an Axios client.
 *      - axiosImportedTo is an object where each key is a chunk name and the value is the name of the Axios client chunk that it imports.
 */
export const findAxiosClients = (
    chunks: Chunks
): { axiosExportedFrom: string[]; axiosImportedTo: { [key: string]: string } } => {
    let axiosExportedFrom: string[] = [];
    let axiosImportedTo: { [key: string]: string } = {};

    // first get those which have axios client
    for (const chunkName of Object.keys(chunks)) {
        if (chunks[chunkName].isAxiosLibrary) {
            axiosExportedFrom.push(chunkName);
        }
    }

    // now, see which ones import those
    for (const chunkName of Object.keys(chunks)) {
        // iterate through the names of the axios clients
        for (const axiosExportFunctionId of axiosExportedFrom) {
            // iterate through the imports of the all the chunks, and see which ones have axios clients imported
            for (const importName of chunks[chunkName].imports) {
                if (importName === axiosExportFunctionId) {
                    axiosImportedTo[chunkName] = axiosExportFunctionId;

                    printMsg(MSG.Run, `[✓] ${chunkName} imports axios client ${axiosExportFunctionId}`);
                }
            }
        }
    }

    return { axiosExportedFrom, axiosImportedTo };
};
