import fs from "fs";
import path from "path";
import parser from "@babel/parser";
import prettier from "prettier";
import secrets from "./secrets.js";
import permutate from "./permutate.js";
import openapi from "./openapi.js";
import { runTrufflehog } from "./trufflehog.js";
import { printMsg, MSG } from "../utility/printMsg.js";

/**
 * Recursively extracts all string literals from a given AST node.
 * @param {object} node - The AST node to extract strings from
 * @returns {string[]} An array of extracted string literals
 */
export const extractStrings = (node: object): string[] => {
    const strings: Set<string> = new Set();
    const seen = new WeakSet();

    function recurse(currentNode: any) {
        if (!currentNode || typeof currentNode !== "object" || seen.has(currentNode)) {
            return;
        }
        seen.add(currentNode);

        if (Array.isArray(currentNode)) {
            currentNode.forEach((item) => recurse(item));
            return;
        }

        if (currentNode.type === "StringLiteral") {
            strings.add(currentNode.value);
        } else if (currentNode.type === "TemplateLiteral") {
            currentNode.quasis.forEach((q) => {
                if (q.value.cooked) {
                    strings.add(q.value.cooked);
                }
            });
        }

        Object.keys(currentNode).forEach((key) => {
            // Avoid traversing location properties and other non-node properties
            if (
                [
                    "loc",
                    "start",
                    "end",
                    "extra",
                    "raw",
                    "comments",
                    "leadingComments",
                    "trailingComments",
                    "innerComments",
                ].includes(key)
            )
                return;
            recurse(currentNode[key]);
        });
    }

    recurse(node);
    return Array.from(strings);
};

/**
 * Extracts all string literals from all .js files in a given directory and its
 * subdirectories and writes them to a JSON file.
 * @param {string} directory - The directory to scan for .js files
 * @param {string} output_file - The file to write the extracted strings to
 */
const strings = async (
    directory: string,
    output_file: string,
    extract_urls: boolean,
    extracted_url_path: string,
    scan_secrets: boolean,
    permutate_option: boolean,
    openapi_option: boolean,
    trufflehog: boolean = false,
    trufflehogBin: string = "trufflehog",
    trufflehogAcceptTerms: boolean = false
): Promise<undefined> => {
    printMsg(MSG.Header, "[i] Loading 'Strings' module");

    // check if the directory exists
    if (!fs.existsSync(directory)) {
        printMsg(MSG.Err, "[!] Directory does not exist");
        process.exit(15);
    }

    printMsg(MSG.Header, `[i] Scanning ${directory} directory`);

    // get all files in the directory and sub-directories
    const files = fs.readdirSync(directory, {
        recursive: true,
        encoding: "utf8",
    });

    // filter out non JS files
    const jsFiles = files.filter((file) => file.endsWith(".js") || file.endsWith(".mjs"));

    // filter out subsequent requests files
    // jsFiles = jsFiles.filter((file) => !file.startsWith("___subsequent_requests"));

    // read all JS files
    const js_files_path = [];
    for (const file of jsFiles) {
        const filePath = path.join(directory, file);
        if (!fs.lstatSync(filePath).isDirectory()) {
            js_files_path.push(filePath);
        }
    }

    printMsg(MSG.Header, `[i] Found ${js_files_path.length} JS files`);

    // read all JS files
    const all_strings = {};
    for (const file of js_files_path) {
        if (file.includes("___subsequent_requests")) {
            // iterate through the file line by line
            const lines = fs.readFileSync(file, "utf-8").split("\n");
            const strings = [];
            for (const line of lines) {
                // if the line matches with a particular regex, then extract the JS snippet
                if (line.match(/^[0-9a-z]+:\[.+/)) {
                    // get the JS snippet
                    let jsCode;
                    try {
                        jsCode = `[${line.match(/\[(.+)\]/)[1]}]`;
                    } catch (err) {
                        continue;
                    }

                    // parse the JS snippet with babel
                    let ast;
                    try {
                        ast = parser.parse(jsCode, {
                            sourceType: "unambiguous",
                            plugins: ["jsx", "typescript"],
                            errorRecovery: true,
                        });
                    } catch (err) {
                        continue;
                    }

                    const extracted = extractStrings(ast);
                    strings.push(...extracted);
                }
            }
            all_strings[file] = strings;
        } else {
            const fileContent = fs.readFileSync(file, "utf-8");

            // parse the file contents with babel. errorRecovery only recovers from
            // certain error classes — a file that isn't valid JS at all (e.g. JSON-LD
            // or speculation-rules content saved with a .js extension) still throws.
            // One bad file must not abort extraction for every other file.
            let ast;
            try {
                ast = parser.parse(fileContent, {
                    sourceType: "unambiguous",
                    plugins: ["jsx", "typescript"],
                    errorRecovery: true,
                });
            } catch (err) {
                printMsg(MSG.Warn, `[!] Skipping ${file}: failed to parse (${err?.message || err})`);
                continue;
            }

            all_strings[file] = extractStrings(ast);
        }
    }

    let strings_count = 0;
    for (const file of Object.keys(all_strings)) {
        strings_count += all_strings[file].length;
    }

    printMsg(MSG.Header, `[i] Extracted ${strings_count} strings`);

    // write to a JSON file
    const formatted = await prettier.format(JSON.stringify(all_strings), {
        parser: "json",
        printWidth: 80,
        singleQuote: true,
    });
    fs.writeFileSync(output_file, formatted);

    printMsg(MSG.Run, `[✓] Extracted strings to ${output_file}`);

    // if -p is enabled, but not -e, or the same case with the --openapi flag
    if ((permutate_option && !extract_urls) || (openapi_option && !extract_urls)) {
        printMsg(MSG.Err, "[!] Please enable -e flag for -p or --openapi flag");
        process.exit(16);
    }

    // if the -e flag is enabled, extract the URLs also
    if (extract_urls) {
        printMsg(MSG.Header, "[i] Extracting URLs and paths from strings");

        let urls = [];
        let paths = [];

        for (const file of Object.keys(all_strings)) {
            for (const string of all_strings[file]) {
                if (string.match(/^https?:\/\/[a-zA-Z0-9\.\-_]+\/?.*$/)) {
                    // like https://site.com
                    urls.push(string);
                }
                if (string.match(/^\/.+$/)) {
                    // like /path/resource
                    // make sure that the path doesn't start with two special chars except '/_'
                    if (string.match(/^\/[^a-zA-Z0-9]/) && !string.startsWith("/_")) {
                        // ignore the path
                    } else {
                        paths.push(string);
                    }
                }
                if (string.match(/^[a-zA-Z0-9_\-]\/[a-zA-Z0-9_\-].*$/)) {
                    // like path/to/resource
                    paths.push(string);
                }
                if (string.startsWith("./") || string.startsWith("../")) {
                    // like "./path/to/resource" or "../path/to/resource"
                    paths.push(string);
                }
                if (string.match(/^.+\.js$/)) {
                    // like "assets/app.abc.js"
                    paths.push(string);
                }
            }
        }

        // dedupe the two lists
        urls = [...new Set(urls)];
        paths = [...new Set(paths)];

        printMsg(MSG.Header, `[i] Found ${urls.length} URLs and ${paths.length} paths`);

        // write to a JSON file
        const formatted_urls = await prettier.format(JSON.stringify({ urls, paths }), {
            parser: "json",
            printWidth: 80,
            singleQuote: true,
        });
        fs.writeFileSync(`${extracted_url_path}.json`, formatted_urls);

        printMsg(MSG.Run, `[✓] Written URLs and paths to ${extracted_url_path}.json`);

        if (permutate_option) {
            await permutate(urls, paths, extracted_url_path);
        }

        if (openapi_option) {
            await openapi(paths, extracted_url_path);
        }
    }

    if (scan_secrets) {
        printMsg(MSG.Header, "[i] Scanning for secrets");

        let total_secrets = 0;

        for (const file of js_files_path) {
            const fileContent = fs.readFileSync(file, "utf8");
            const foundSecrets = await secrets(fileContent);
            if (foundSecrets.length > 0) {
                for (const foundSecret of foundSecrets) {
                    printMsg(MSG.Run, `[✓] Found ${foundSecret.name} in ${file}`);
                    printMsg(MSG.Run, foundSecret.value);
                    total_secrets++;
                }
            }
        }

        if (total_secrets === 0) {
            printMsg(MSG.Warn, `[!] No secrets found`);
        } else {
            printMsg(MSG.Run, `[✓] Found ${total_secrets} secrets`);
        }
    }

    if (trufflehog) {
        await runTrufflehog(directory, trufflehogBin, trufflehogAcceptTerms);
    }
};

export default strings;
