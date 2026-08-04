import { writeFile } from "fs/promises";
import path from "path";
import { printMsg, MSG } from "../utility/printMsg.js";

/**
 * Generates an OpenAPI v3 file based on the provided paths.
 *
 * @param {string[]} paths - Array of paths to include in the OpenAPI file
 * @param {string} output_file - Base name of the output file (without extension)
 *
 * @returns {Promise<void>} - Promise that resolves when the OpenAPI file is saved
 */
const openapi = async (paths, output_file) => {
    printMsg(MSG.Header, "[i] Generating OpenAPI v3 file");

    const openapiData = {
        openapi: "3.0.0",
        info: {
            title: "API Collection",
            description: "A collection of API endpoints discovered by js-recon.",
            version: "1.0.0",
        },
        servers: [
            {
                url: "{{baseUrl}}",
                description: "Base URL for the API",
            },
        ],
        paths: {},
    };

    for (const p of paths) {
        const pathKey = p.startsWith("/") ? p : `/${p}`;
        if (!openapiData.paths[pathKey]) {
            openapiData.paths[pathKey] = {};
        }
        // Assuming GET method for all paths for now.
        // This can be expanded later.
        openapiData.paths[pathKey].get = {
            summary: `Discovered endpoint: ${pathKey}`,
            description: `An endpoint discovered at ${pathKey}.`,
            responses: {
                200: {
                    description: "Successful response. The actual response will vary.",
                },
            },
        };
    }

    try {
        await writeFile(`${output_file}-openapi.json`, JSON.stringify(openapiData, null, 2));
        printMsg(MSG.Run, `[✓] OpenAPI v3 file saved to: ${output_file}-openapi.json`);
    } catch (error) {
        printMsg(MSG.Err, `[!] Error writing OpenAPI file: ${error.message}`);
    }
};

export default openapi;
