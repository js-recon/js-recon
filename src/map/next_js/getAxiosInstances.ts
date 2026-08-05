import { Chunks } from "../../utility/interfaces.js";
import fs from "fs";
import { printMsg, MSG } from "../../utility/printMsg.js";

/**
 * Detects and marks chunks that contain Axios HTTP client library instances.
 *
 * Uses regex patterns to identify chunks containing Axios-specific code patterns
 * such as AxiosHeaders, isAxiosError, and AxiosError. When detected, marks the
 * chunk with an isAxiosClient flag and updates its description.
 *
 * @param chunks - Collection of code chunks to analyze for Axios instances
 * @param output - Base filename for output files (without extension)
 * @param formats - Array of output formats to generate (e.g., ['json'])
 * @returns Promise that resolves to the updated chunks with Axios detection results
 */
const getAxiosInstances = async (chunks: Chunks, output: string, formats: string[]): Promise<Chunks> => {
    printMsg(MSG.Header, "[i] Getting axios instances");

    const chunkCopy = structuredClone(chunks);
    // iterate through all the chunks
    for (const chunk of Object.values(chunks)) {
        const chunkCode = chunk.code;

        // regex checks first
        const axiosVarRegex_AxiosHeaders = /AxiosHeaders = /;
        const axiosVarRegex_isAxiosError = /isAxiosError = /;
        const axiosVarRegex_AxiosError = /AxiosError = /;
        const axiosObjectRegex_AxiosHeaders = /\.AxiosHeaders/;
        const axiosObjectRegex_isAxiosError = /\.isAxiosError/;
        const axiosObjectRegex_AxiosError = /\.AxiosError/;

        // go through the code, and see if all of these matches or not
        let axiosDetected = false;
        if (
            axiosVarRegex_AxiosHeaders.test(chunkCode) &&
            axiosVarRegex_isAxiosError.test(chunkCode) &&
            axiosVarRegex_AxiosError.test(chunkCode) &&
            axiosObjectRegex_AxiosHeaders.test(chunkCode) &&
            axiosObjectRegex_isAxiosError.test(chunkCode) &&
            axiosObjectRegex_AxiosError.test(chunkCode)
        ) {
            axiosDetected = true;
        }

        if (axiosDetected) {
            chunkCopy[chunk.id].isAxiosLibrary = true;
            if (chunks[chunk.id].description === "none") {
                chunkCopy[chunk.id].description = "Axios library";
            }
            printMsg(MSG.Run, `[✓] Axios detected in chunk ${chunk.id}`);
        }
    }

    // write the chunk to the output file
    if (formats.includes("json")) {
        const chunks_json = JSON.stringify(chunkCopy, null, 2);
        fs.writeFileSync(`${output}.json`, chunks_json);
        printMsg(MSG.Run, `[✓] Saved webpack with axios instances to ${output}.json`);
    }

    return chunkCopy;
};

export default getAxiosInstances;
