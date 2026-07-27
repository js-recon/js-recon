import makeRequest from "../../utility/makeReq.js";
import chalk from "chalk";
import resolvePath from "../../utility/resolvePath.js";
import { extractImportPaths } from "./angular_recursiveChunkImports.js";

/**
 * Parses the main.js file of an Angular application to extract lazy-loaded module paths.
 * It traverses the AST to find dynamic import() expressions and extracts the chunk paths.
 *
 * @param mainJsUrl The full URL to the main.js file.
 * @returns A promise that resolves to an array of strings, where each string is a path to a lazy-loaded chunk.
 */
const angular_getFromMainJs = async (mainJsUrl: string): Promise<string[]> => {
    console.log(chalk.cyan("[i] Analyzing main.js from", mainJsUrl));

    const mainJsRes = await makeRequest(mainJsUrl, {});
    const mainJsBody = await mainJsRes.text();

    const importPaths = extractImportPaths(mainJsBody);

    const resolvedPaths: string[] = [];
    for (const importPath of importPaths) {
        try {
            resolvedPaths.push(resolvePath(mainJsUrl, importPath));
        } catch {
            continue;
        }
    }
    return resolvedPaths;
};

export default angular_getFromMainJs;
