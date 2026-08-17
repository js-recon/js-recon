import * as parser from "@babel/parser";
import traverse from "@babel/traverse";
import fs from "fs";
import path from "path";
import { printMsg, MSG } from "../../utility/printMsg.js";

/**
 * Extracts client-side paths from JSON.parse() calls in JavaScript files.
 *
 * Analyzes JavaScript files to find JSON.parse() calls with string literals as arguments.
 * When the parsed JSON contains objects with keys that look like paths (starting with '/'),
 * those keys are extracted as potential client-side routes.
 *
 * @param directory - The directory path containing JavaScript files to analyze
 * @returns Promise that resolves to an array of discovered paths from JSON.parse() calls
 */
const client_jsonParse = async (directory: string): Promise<string[]> => {
    const foundUrls = [];
    printMsg(MSG.Header, "[i] Searching for client-side paths in JSON.parse()");

    // filter out the directories
    let files = fs.readdirSync(directory, {
        recursive: true,
        encoding: "utf8",
    });
    files = files.filter((file) => !fs.statSync(path.join(directory, file)).isDirectory());

    // filter out the subsequent requests files
    files = files.filter((file) => !file.startsWith("___subsequent_requests"));

    for (const file of files) {
        // read the file
        const code = fs.readFileSync(path.join(directory, file), "utf8");

        // parse the code with ast
        let ast;
        try {
            ast = parser.parse(code, {
                sourceType: "unambiguous",
                plugins: ["jsx", "typescript"],
                errorRecovery: true,
            });

            // traverse the ast, and find all the instances where JSON.parse() is used with a string as its
            // argument, and if you parse that string, it contains paths
            traverse(ast, {
                CallExpression(path) {
                    const callee = path.get("callee");
                    if (callee.matchesPattern("JSON.parse")) {
                        const args = path.get("arguments");
                        if (args.length > 0 && args[0].isStringLiteral()) {
                            const jsonString = args[0].node.value;
                            try {
                                const parsedData = JSON.parse(jsonString);

                                // get all the keys of parsedData
                                const keys = Object.keys(parsedData);

                                // check if they all match the regex of path
                                let matched = true;

                                for (const key of keys) {
                                    if (!key.match(/^\/[\w\.\/\-]*$/)) {
                                        matched = false;
                                        break;
                                    }
                                }

                                if (matched) {
                                    // push all the keys to foundUrls
                                    foundUrls.push(...keys);
                                }
                            } catch (e) {
                                // Ignore errors from JSON.parse
                            }
                        }
                    }
                },
            });
        } catch (err) {
            printMsg(MSG.Err, `[!] Error when parsing JSON: ${err}`);
        }
    }

    return foundUrls;
};

export default client_jsonParse;
