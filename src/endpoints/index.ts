import fs from "fs";
import { printMsg, MSG } from "../utility/printMsg.js";

// Next.JS
import client_subsequentRequests from "./next_js/client_subsequentRequests.js";
import client_jsFilesHref from "./next_js/client_jsFilesHref.js";
import client_jsonParse from "./next_js/client_jsonParse.js";
import client_mappedJsonFile from "./next_js/client_mappedJsonFile.js";

// Report Generation
import gen_json from "./gen_report/gen_json.js";

/** Available technology stacks for endpoint extraction */
const techs = ["Next.JS (next)"];
/** Supported output formats for endpoint results */
const outputFormats = ["json"];

/**
 * Extracts client-side endpoints from JavaScript applications.
 *
 * Analyzes JavaScript files and mapped data to discover client-side routes,
 * API endpoints, and other paths used by the application. Supports different
 * technology stacks and output formats.
 *
 * @param url - Base URL for resolving relative paths
 * @param directory - Directory containing JavaScript files to analyze
 * @param output - Output filename (without extension) for results
 * @param outputFormat - Array of output formats to generate (e.g., ['json'])
 * @param tech - Technology stack identifier (e.g., 'next' for Next.js)
 * @param list - Whether to list available technologies instead of running extraction
 * @param mappedJsonFile - Path to mapped JSON file for additional analysis
 * @returns Promise that resolves when endpoint extraction is complete
 */
const endpoints = async (
    url: string | undefined,
    directory: string | undefined,
    output: string | undefined,
    outputFormat: string[] | undefined,
    tech: string | undefined,
    list: boolean | undefined,
    mappedJsonFile: string | undefined
): Promise<void> => {
    printMsg(MSG.Header, "[i] Loading endpoints module");

    // list available technologies
    if (list) {
        printMsg(MSG.Header, "[i] Listing available technologies");
        for (const tech of techs) {
            printMsg(MSG.Run, `- ${tech}`);
        }
        return;
    }

    // iterate over the output format, and match it with the available output formats
    for (const format of outputFormat) {
        if (!outputFormats.includes(format)) {
            printMsg(MSG.Err, "[!] Invalid output format");
            return;
        }
    }

    // check if the technology is present
    if (!tech) {
        printMsg(MSG.Err, "[!] Please provide a technology");
        return;
    }

    // check if the output file is present
    if (!output) {
        printMsg(MSG.Err, "[!] Please provide an output file");
        return;
    }

    // check if the url is present
    if (!url) {
        printMsg(MSG.Err, "[!] Please provide a URL");
        return;
    }

    printMsg(MSG.Header, "[i] Extracting endpoints");

    if (tech === "next") {
        printMsg(MSG.Header, "[i] Checking for client-side paths for Next.JS");

        // var to store all the paths found
        const final_client_side: string[] = [];

        if (directory) {
            const subsequentRequestsDir = directory + "/___subsequent_requests";
            if (!fs.existsSync(subsequentRequestsDir)) {
                printMsg(
                    MSG.Warn,
                    "[!] Directory containing subsequent requests does not exist — skipping subsequent requests extraction"
                );
            } else {
                const client_subsequentRequestsResult = await client_subsequentRequests(subsequentRequestsDir, url);
                final_client_side.push(...client_subsequentRequestsResult);
            }

            const client_jsFilesHrefResult = await client_jsFilesHref(directory);
            final_client_side.push(...client_jsFilesHrefResult);

            const client_jsonParseResult = await client_jsonParse(directory);
            final_client_side.push(...client_jsonParseResult);
        }

        // now, use the mapped JSON file to find more paths
        if (mappedJsonFile) {
            const client_mappedJsonFileResult = await client_mappedJsonFile(mappedJsonFile);
            final_client_side.push(...client_mappedJsonFileResult);
        }

        if (outputFormat.includes("json")) {
            const gen_jsonResult = await gen_json(url, final_client_side, output);
        }
    }
};

export default endpoints;
