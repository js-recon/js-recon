import makeRequest from "../../utility/makeReq.js";
import parser from "@babel/parser";
import _traverse from "@babel/traverse";
import * as cheerio from "cheerio";
import chalk from "chalk";
import { progressError, progressLog, progressWarn } from "../../utility/progressLog.js";

const traverse = (_traverse.default ?? _traverse) as typeof _traverse.default;

const vue_singleJsFileOnHome = async (url: string) => {
    let jsFilesFound: string[] = [];

    // first, get the home page content
    const req = await makeRequest(url, {});
    if (req == null) {
        progressError(chalk.red(`Failed to fetch ${url}`));
        return jsFilesFound;
    }
    const homePageContent = await req.text();

    // load the home page content into cheerio
    const $ = cheerio.load(homePageContent);

    // go through the home page HTML, and find the
    // count of <script> tags that loads external JS
    let externalScriptTagCount = 0;
    let jsUrl = "";

    $("script").each((_, el) => {
        if ($(el).attr("src")) {
            externalScriptTagCount++;
            jsUrl = $(el).attr("src");
        }
    });

    // if the count is 1, then it's a single JS file
    if (externalScriptTagCount !== 1) {
        return jsFilesFound;
    }

    // if the count is 1, then it's a single JS file
    progressLog(chalk.green("[✓] Single JS file detected"));

    // add that JS file to the list
    jsFilesFound.push(new URL(jsUrl, url).href);

    // print the warning
    progressWarn(chalk.yellow("[!] This method is MEMORY INTENSIVE. Underpowered devices may freeze"));

    // resolve the URL
    if (jsUrl.startsWith("/") || jsUrl.startsWith("./") || jsUrl.startsWith("../")) {
        jsUrl = new URL(jsUrl, url).href;
    }

    // get the contents of that JS file
    const jsReq = await makeRequest(jsUrl);
    if (!jsReq) {
        progressError(chalk.red(`Failed to fetch ${jsUrl}`));
        return jsFilesFound;
    }
    const jsContent = await jsReq.text();

    // parse the JS file
    const ast = parser.parse(jsContent, {
        sourceType: "unambiguous",
        plugins: ["jsx", "typescript"],
        errorRecovery: true,
    });

    // traverse the AST
    let initialFoundJsPaths: string[] = [];
    traverse(ast, {
        ArrayExpression(path) {
            const elements = path.node.elements;
            if (!elements) return;

            const currentJsFiles: string[] = [];
            let hasJs = false;
            let isPureJsCssList = true;

            for (const element of elements) {
                // element can be null in sparse arrays
                if (!element || element.type !== "StringLiteral") {
                    isPureJsCssList = false;
                    break;
                }

                const value = element.value;
                if (value.endsWith(".js")) {
                    hasJs = true;
                    currentJsFiles.push(value);
                } else if (!value.endsWith(".css")) {
                    // If it's not .js and not .css, it's not the list we're looking for
                    isPureJsCssList = false;
                    break;
                }
            }

            if (isPureJsCssList && hasJs) {
                initialFoundJsPaths.push(...currentJsFiles);
            }
        },
    });

    // now that paths are found, iterate through those, and construct the full URLs
    for (const path of initialFoundJsPaths) {
        if (!path.endsWith(".js")) continue;

        const fullUrl = new URL(path, url).href;
        jsFilesFound.push(fullUrl);
    }

    return jsFilesFound;
};

export default vue_singleJsFileOnHome;
