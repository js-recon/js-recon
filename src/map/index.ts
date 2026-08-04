import fs from "fs";

// Next.JS
import getWebpackConnections from "./next_js/getWebpackConnections.js";
import getTurbopackConnections from "./next_js/getTurbopackConnections.js";
import getFetchInstances from "./next_js/getFetchInstances.js";
import resolveFetch from "./next_js/resolveFetch.js";
import resolveNewRequest from "./next_js/resolveNewRequest.js";
import interactive, { runCommands as nextRunCommands } from "./next_js/interactive.js";
import { existsSync, readFileSync } from "fs";
import { Chunks } from "../utility/interfaces.js";
import getAxiosInstances from "./next_js/getAxiosInstances.js";
import resolveAxios from "./next_js/resolveAxios.js";
import { getOpenapi, getOpenapiOutput, getOpenapiOutputFile, getGraphqlEnabled } from "../utility/globals.js";
import resolveGraphql from "./graphql/resolveGraphql.js";
import { generateOpenapiV3Spec } from "../utility/openapiGenerator.js";
import { generatePostmanCollection } from "../utility/postmanGenerator.js";
import getExports from "./next_js/getExports.js";
import resolveServerActions from "./next_js/resolveServerActions.js";
import { printMsg, MSG } from "../utility/printMsg.js";

// Vue.JS
import getViteConnections from "./vue_js/getViteConnections.js";
import vueInteractive, { runCommands as vueRunCommands } from "./vue_js/interactive.js";
import vue_resolveFetch from "./vue_js/vue_resolveFetch.js";

// Svelte/Astro
import svelteInteractive, { runCommands as svelteRunCommands } from "./svelte_js/interactive.js";

// React
import getReactConnections from "./react_js/getReactConnections.js";
import reactInteractive, { runCommands as reactRunCommands } from "./react_js/interactive.js";
import react_resolveFetch from "./react_js/react_resolveFetch.js";

// Angular
import getAngularConnections from "./angular_js/getAngularConnections.js";
import angularInteractive, { runCommands as angularRunCommands } from "./angular_js/interactive.js";

// XHR resolution (shared across Vite-based techs)
import vue_resolveXhr from "./vue_js/vue_resolveXhr.js";
import vue_resolveHttpClient from "./vue_js/vue_resolveHttpClient.js";

const availableTech = {
    next: "Next.JS",
    vue: "Vue.JS",
    react: "React",
    svelte: "Svelte/Astro",
    angular: "Angular",
};

const availableFormats = {
    json: "JSON",
};

/**
 * Maps and analyzes JavaScript code to identify functions, API calls, and connections.
 *
 * This function orchestrates the mapping process by:
 * 1. Analyzing webpack connections and chunk relationships
 * 2. Extracting exports and function definitions
 * 3. Identifying fetch and axios instances
 * 4. Resolving API calls and their parameters
 * 5. Optionally generating OpenAPI specifications
 *
 * @param directory - Directory containing JavaScript files to analyze
 * @param output - Base filename for output files (without extension)
 * @param formats - Array of output formats to generate (e.g., ['json'])
 * @param tech - Technology stack identifier (e.g., 'next' for Next.js)
 * @param list - Whether to list available technologies instead of running analysis
 * @param interactive_mode - Whether to launch interactive mode after analysis
 * @returns Promise that resolves when mapping analysis is complete
 */
const map = async (
    directory: string,
    output: string,
    formats: Array<keyof typeof availableFormats>,
    tech: string,
    list: boolean,
    interactive_mode: boolean,
    commands: string[] = []
): Promise<void> => {
    printMsg(MSG.Header, "[i] Running 'map' module");

    if (list) {
        printMsg(MSG.Header, "Available technologies:");
        for (const [key, value] of Object.entries(availableTech)) {
            printMsg(MSG.Header, `- '${key}': ${value}`);
        }
        return;
    }

    // iterate through all the formats, and match it with the available formats
    for (const format of formats) {
        if (!Object.keys(availableFormats).includes(format)) {
            printMsg(MSG.Err, `[!] Invalid format: ${format}`);
            process.exit(4);
        }
    }

    if (!tech) {
        printMsg(
            MSG.Err,
            "[!] Please specify a technology with -t/--tech. Run with -l/--list to see available technologies"
        );
        process.exit(5);
    }

    if (!directory) {
        printMsg(MSG.Err, "[!] Please specify a directory with -d/--directory");
        process.exit(6);
    }

    if (tech === "next") {
        let chunks: Chunks;

        let allOutputFilesAvailable = true;
        Object.keys(availableFormats).map((key, value) => {
            if (!existsSync(`${output}.${key}`)) {
                allOutputFilesAvailable = false;
            }
        });

        if (!allOutputFilesAvailable) {
            // skip regeneration if output file already exists
            chunks = await getWebpackConnections(directory, output, formats);

            // also collect Turbopack chunks (Next.JS apps may be built with either bundler)
            chunks = await getTurbopackConnections(directory, output, formats, chunks);

            // get the exports
            chunks = await getExports(chunks);

            // now, iterate through them, and check fetch instances
            chunks = await getFetchInstances(chunks, output, formats);

            // now, iterate through them, and check axios instances
            chunks = await getAxiosInstances(chunks, output, formats);
        } else {
            // read the JSON file, and load the value
            chunks = JSON.parse(readFileSync(`${output}.json`, { encoding: "utf8" }));
        }

        // resolve fetch once you've got all
        await resolveFetch(chunks, directory);

        // also, the axios instances
        await resolveAxios(chunks, directory);

        // wrapper-class HTTP requests:  new X({url, method, ...})
        await resolveNewRequest(chunks, directory);

        // Next.js Server Actions registered via createServerReference(...)
        await resolveServerActions(chunks, directory);

        if (commands.length > 0) {
            await nextRunCommands(chunks, `${output}.json`, commands);
        } else if (interactive_mode) {
            await interactive(chunks, `${output}.json`);
        }

        if (getOpenapi() === true && getGraphqlEnabled()) {
            await resolveGraphql(directory);
        }

        // check if the openapi output is enabled. if so, then write to file
        if (getOpenapi() === true) {
            // convert the openapi output to JSON
            // it should be openapi v3 specification
            const openapiSpec = generateOpenapiV3Spec(getOpenapiOutput(), chunks);
            const openapiJson = JSON.stringify(openapiSpec, null, 2);
            // write to file
            fs.writeFileSync(getOpenapiOutputFile(), openapiJson);
            printMsg(MSG.Run, `[✓] Generated OpenAPI spec at ${getOpenapiOutputFile()}`);

            // Also emit a Postman Collection v2.1 — Bruno/Insomnia/Postman use its
            // nested `item` arrays to render real folder hierarchies on import,
            // which a flat OpenAPI tag list can't represent.
            const postmanCollection = generatePostmanCollection(getOpenapiOutput());
            const openapiOutputFile = getOpenapiOutputFile();
            const postmanOutputFile = openapiOutputFile.endsWith(".json")
                ? openapiOutputFile.replace(/\.json$/, ".postman_collection.json")
                : `${openapiOutputFile}.postman_collection.json`;
            fs.writeFileSync(postmanOutputFile, JSON.stringify(postmanCollection, null, 2));
            printMsg(MSG.Run, `[✓] Generated Postman Collection at ${postmanOutputFile}`);
        }
    } else if (tech === "vue") {
        let chunks: Chunks;

        if (!existsSync(`${output}.json`)) {
            chunks = await getViteConnections(directory, output, formats);
        } else {
            chunks = JSON.parse(readFileSync(`${output}.json`, { encoding: "utf8" }));
        }

        // Resolve fetch instances across all Vue.JS files
        await vue_resolveFetch(directory);
        await vue_resolveXhr(directory);
        await vue_resolveHttpClient(directory);

        if (commands.length > 0) {
            await vueRunCommands(chunks, `${output}.json`, commands);
        } else if (interactive_mode) {
            await vueInteractive(chunks, `${output}.json`);
        }

        if (getOpenapi() === true && getGraphqlEnabled()) {
            await resolveGraphql(directory);
        }

        // Generate OpenAPI spec and Postman collection if enabled
        if (getOpenapi() === true) {
            const openapiSpec = generateOpenapiV3Spec(getOpenapiOutput(), chunks);
            const openapiJson = JSON.stringify(openapiSpec, null, 2);
            fs.writeFileSync(getOpenapiOutputFile(), openapiJson);
            printMsg(MSG.Run, `[✓] Generated OpenAPI spec at ${getOpenapiOutputFile()}`);

            const postmanCollection = generatePostmanCollection(getOpenapiOutput());
            const openapiOutputFile = getOpenapiOutputFile();
            const postmanOutputFile = openapiOutputFile.endsWith(".json")
                ? openapiOutputFile.replace(/\.json$/, ".postman_collection.json")
                : `${openapiOutputFile}.postman_collection.json`;
            fs.writeFileSync(postmanOutputFile, JSON.stringify(postmanCollection, null, 2));
            printMsg(MSG.Run, `[✓] Generated Postman Collection at ${postmanOutputFile}`);
        }
    } else if (tech === "react") {
        let chunks: Chunks;

        if (!existsSync(`${output}.json`)) {
            chunks = await getReactConnections(directory, output, formats);
        } else {
            chunks = JSON.parse(readFileSync(`${output}.json`, { encoding: "utf8" }));
        }

        await react_resolveFetch(directory);
        await vue_resolveXhr(directory, "React");
        await vue_resolveHttpClient(directory, "React");

        if (commands.length > 0) {
            await reactRunCommands(chunks, `${output}.json`, commands);
        } else if (interactive_mode) {
            await reactInteractive(chunks, `${output}.json`);
        }

        if (getOpenapi() === true && getGraphqlEnabled()) {
            await resolveGraphql(directory);
        }

        if (getOpenapi() === true) {
            const openapiSpec = generateOpenapiV3Spec(getOpenapiOutput(), chunks);
            const openapiJson = JSON.stringify(openapiSpec, null, 2);
            fs.writeFileSync(getOpenapiOutputFile(), openapiJson);
            printMsg(MSG.Run, `[✓] Generated OpenAPI spec at ${getOpenapiOutputFile()}`);

            const postmanCollection = generatePostmanCollection(getOpenapiOutput());
            const openapiOutputFile = getOpenapiOutputFile();
            const postmanOutputFile = openapiOutputFile.endsWith(".json")
                ? openapiOutputFile.replace(/\.json$/, ".postman_collection.json")
                : `${openapiOutputFile}.postman_collection.json`;
            fs.writeFileSync(postmanOutputFile, JSON.stringify(postmanCollection, null, 2));
            printMsg(MSG.Run, `[✓] Generated Postman Collection at ${postmanOutputFile}`);
        }
    } else if (tech === "svelte") {
        let chunks: Chunks;

        if (!existsSync(`${output}.json`)) {
            // Astro+Svelte uses Vite — same chunk format as Vue.JS
            chunks = await getViteConnections(directory, output, formats);
        } else {
            chunks = JSON.parse(readFileSync(`${output}.json`, { encoding: "utf8" }));
        }

        await vue_resolveFetch(directory, "Svelte/Astro");
        await vue_resolveXhr(directory, "Svelte/Astro");
        await vue_resolveHttpClient(directory, "Svelte/Astro");

        if (commands.length > 0) {
            await svelteRunCommands(chunks, `${output}.json`, commands);
        } else if (interactive_mode) {
            await svelteInteractive(chunks, `${output}.json`);
        }

        if (getOpenapi() === true && getGraphqlEnabled()) {
            await resolveGraphql(directory);
        }

        if (getOpenapi() === true) {
            const openapiSpec = generateOpenapiV3Spec(getOpenapiOutput(), chunks);
            const openapiJson = JSON.stringify(openapiSpec, null, 2);
            fs.writeFileSync(getOpenapiOutputFile(), openapiJson);
            printMsg(MSG.Run, `[✓] Generated OpenAPI spec at ${getOpenapiOutputFile()}`);

            const postmanCollection = generatePostmanCollection(getOpenapiOutput());
            const openapiOutputFile = getOpenapiOutputFile();
            const postmanOutputFile = openapiOutputFile.endsWith(".json")
                ? openapiOutputFile.replace(/\.json$/, ".postman_collection.json")
                : `${openapiOutputFile}.postman_collection.json`;
            fs.writeFileSync(postmanOutputFile, JSON.stringify(postmanCollection, null, 2));
            printMsg(MSG.Run, `[✓] Generated Postman Collection at ${postmanOutputFile}`);
        }
    } else if (tech === "angular") {
        let chunks: Chunks;

        if (!existsSync(`${output}.json`)) {
            chunks = await getAngularConnections(directory, output, formats);
        } else {
            chunks = JSON.parse(readFileSync(`${output}.json`, { encoding: "utf8" }));
        }

        await vue_resolveFetch(directory, "Angular");
        await vue_resolveXhr(directory, "Angular");
        await vue_resolveHttpClient(directory, "Angular");

        if (commands.length > 0) {
            await angularRunCommands(chunks, `${output}.json`, commands);
        } else if (interactive_mode) {
            await angularInteractive(chunks, `${output}.json`);
        }

        if (getOpenapi() === true && getGraphqlEnabled()) {
            await resolveGraphql(directory);
        }

        if (getOpenapi() === true) {
            const openapiSpec = generateOpenapiV3Spec(getOpenapiOutput(), chunks);
            const openapiJson = JSON.stringify(openapiSpec, null, 2);
            fs.writeFileSync(getOpenapiOutputFile(), openapiJson);
            printMsg(MSG.Run, `[✓] Generated OpenAPI spec at ${getOpenapiOutputFile()}`);

            const postmanCollection = generatePostmanCollection(getOpenapiOutput());
            const openapiOutputFile = getOpenapiOutputFile();
            const postmanOutputFile = openapiOutputFile.endsWith(".json")
                ? openapiOutputFile.replace(/\.json$/, ".postman_collection.json")
                : `${openapiOutputFile}.postman_collection.json`;
            fs.writeFileSync(postmanOutputFile, JSON.stringify(postmanCollection, null, 2));
            printMsg(MSG.Run, `[✓] Generated Postman Collection at ${postmanOutputFile}`);
        }
    }
};

export default map;
