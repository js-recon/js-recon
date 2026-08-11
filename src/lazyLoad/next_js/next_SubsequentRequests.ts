import chalk from "chalk";
import { printMsg, MSG } from "../../utility/printMsg.js";
import cliProgress from "cli-progress";
import fs from "fs";
import path from "path";
import { getURLDirectory } from "../../utility/urlUtils.js";
import makeRequest from "../../utility/makeReq.js";
import * as cheerio from "cheerio";
import { activateBarLogger, computeBarSize, watchBarResize, withProgressResources } from "../../utility/progressLog.js";
import { resolveHostOutputDirectory } from "../outputPath.js";

let queue = 0;
let max_queue;

/**
 * Finds all static JS files from a given JavaScript content.
 * @param {string} js_content - The JavaScript content to search in.
 * @returns {Promise<string[]>} - A promise that resolves to an array of static JS file URLs.
 */
const findStaticFiles = async (js_content) => {
    // do some regex-ing
    // include `~` because Turbopack content-hashed filenames use it as a separator
    // (e.g. `static/chunks/18865ghy~7gi9.js`)
    const matches = [...js_content.matchAll(/\/?static\/chunks\/[a-zA-Z0-9\._\-\/~]+\.js/g)];
    // return matches

    const toReturn = [];

    for (const match of matches) {
        toReturn.push(match[0]);
    }

    return toReturn;
};

const getURLDirectoryServer = (urlString) => {
    const url = new URL(urlString);
    const pathParts = url.pathname.split("/").filter(Boolean); // ['business', 'api']
    pathParts.pop(); // Remove 'api'

    const newPath = "/" + pathParts.join("/"); // '/business'
    return `${url.origin}${newPath}`; // 'http://something.com/business'
};

const subsequentRequests = async (
    url,
    urlsFile,
    threads,
    output,
    js_urls,
    isBatch = false
): Promise<string[] | any> => {
    max_queue = threads;
    let staticJSURLs = [];

    // open the urls file, and load the paths (JSON)
    if (!fs.existsSync(urlsFile)) {
        printMsg(MSG.Err, `[!] URLs file ${urlsFile} does not exist`);
        printMsg(MSG.Warn, `[!] Please run strings module first with -e flag`);
        printMsg(MSG.Warn, `[!] Example: js-recon strings -d <directory> -e`);
        process.exit(17);
    }
    let endpoints = JSON.parse(fs.readFileSync(urlsFile, "utf8")).paths;

    // add `/` to endpoints
    endpoints.push("/");

    // Deduplicate by path — same path with different query params counts once
    const seenPaths = new Set<string>();
    endpoints = endpoints.filter((endpoint: string) => {
        let pathname: string;
        try {
            pathname = new URL(endpoint, url).pathname;
        } catch {
            pathname = endpoint;
        }
        if (seenPaths.has(pathname)) return false;
        seenPaths.add(pathname);
        return true;
    });

    const multiBar = new cliProgress.MultiBar(
        {
            format:
                chalk.cyan("[i] Fetching JS files from subsequent requests ") +
                "[{bar}] {percentage}% | {value}/{total} | {phase}",
            barCompleteChar: "█",
            barIncompleteChar: "░",
            barsize: computeBarSize(73),
            hideCursor: false,
            clearOnComplete: false,
            stopOnComplete: false,
        },
        cliProgress.Presets.shades_classic
    );
    const progressBar = multiBar.create(endpoints.length * 2, 0, { phase: "RSC" });
    const stopBarWatcher = watchBarResize(progressBar, 73);
    const releaseBarLogger = activateBarLogger(multiBar, process.stdout.isTTY === true);

    const js_contents = {};
    let jsFilesFromPageHtml: string[] = [];

    await withProgressResources(
        async () => {
            // make requests to all of them with the special header
            const reqPromises = endpoints.map(async (endpoint) => {
                const reqUrl = new URL(endpoint, url).href;
                try {
                    // delay in case over the thread count
                    while (queue >= max_queue) {
                        await new Promise((resolve) => setTimeout(resolve, 100));
                    }
                    queue++;

                    const res = await makeRequest(reqUrl, {
                        headers: {
                            RSC: "1",
                        },
                    });

                    if (res && res.status === 200 && res.headers.get("content-type")?.includes("text/x-component")) {
                        const text = await res.text();
                        js_contents[endpoint] = text;

                        const { rawHost, directory } = getURLDirectory(reqUrl);

                        // save the contents to "___subsequent_requests/"
                        // make the subsequent_requests directory if it doesn't exist

                        const output_path = path.join(
                            resolveHostOutputDirectory(output, rawHost, isBatch),
                            "___subsequent_requests",
                            directory
                        );
                        if (!fs.existsSync(output_path)) {
                            fs.mkdirSync(output_path, { recursive: true });
                        }
                        fs.writeFileSync(path.join(output_path, "index.js"), text);

                        // find the static ones from the JS resp
                        const staticFiles = await findStaticFiles(text);

                        // go through each file and get the absolute path of those
                        const absolutePaths = staticFiles.map((file) => {
                            // go through existing JS URLs found
                            let js_path_dir;
                            for (const js_url of js_urls) {
                                if (
                                    !js_path_dir &&
                                    new URL(js_url).host === new URL(url).host &&
                                    new URL(js_url).pathname.includes("static/chunks/")
                                ) {
                                    js_path_dir = js_url.replace(/\/[^\/]+\.js.*$/, "");
                                }
                            }
                            return js_path_dir.replace("static/chunks", "") + file;
                        });

                        // Filter out paths that are already in js_urls before pushing to staticJSURLs
                        const newPaths = absolutePaths.filter((path) => !js_urls.includes(path));
                        if (newPaths.length > 0) {
                            staticJSURLs.push(...newPaths);
                        }
                    }

                    queue--;
                } catch (e) {
                    queue--;
                    multiBar.log(chalk.red(`[!] Error fetching ${reqUrl}: ${e}\n`));
                }
                progressBar.increment(1, { phase: "RSC" });
            });

            await Promise.all(reqPromises);

            staticJSURLs = [...new Set(staticJSURLs)];

            // in addition to the RSC:1 method, the script tags on the webpage of valid client-side paths also have the JS files
            // since we found the possible paths in the previous iteration, we can use that to find the JS files on those pages
            // as well

            const htmlPromises = endpoints.map(async (endpoint) => {
                const reqUrl = new URL(endpoint, url).href;

                while (queue >= max_queue) {
                    await new Promise((resolve) => setTimeout(resolve, 100));
                }
                queue++;

                try {
                    const req = await makeRequest(reqUrl);
                    if (!req) {
                        progressBar.increment(1, { phase: "HTML" });
                        return;
                    }
                    const resText = await req.text();
                    const $ = cheerio.load(resText);

                    const extract_regex = /static\/chunks\/[a-zA-Z0-9_\-~.]+\.js/g;

                    $("script").each((_, script) => {
                        if (!$(script).attr("src")) {
                            const scriptContent = $(script).html();
                            if (scriptContent) {
                                const matches = scriptContent.matchAll(extract_regex);
                                for (const match of matches) {
                                    jsFilesFromPageHtml.push(match[0]);
                                }
                            }
                        }
                    });
                } catch (e) {
                    multiBar.log(chalk.red(`[!] Error fetching HTML for ${reqUrl}: ${e}\n`));
                } finally {
                    queue--;
                }
                progressBar.increment(1, { phase: "HTML" });
            });

            await Promise.all(htmlPromises);
        },
        () => multiBar.stop(),
        stopBarWatcher,
        releaseBarLogger
    );

    // build the full URL from path
    jsFilesFromPageHtml = jsFilesFromPageHtml.map((file) => {
        // go through existing JS URLs found
        let js_path_dir;
        for (const js_url of js_urls) {
            if (
                !js_path_dir &&
                new URL(js_url).host === new URL(url).host &&
                new URL(js_url).pathname.includes("static/chunks/")
            ) {
                js_path_dir = js_url.replace(/\/[^\/]+\.js.*$/, "");
            }
        }
        if (js_path_dir) {
            return js_path_dir.replace("static/chunks", "") + file;
        }
        return file;
    });

    // dedupe
    jsFilesFromPageHtml = [...new Set(jsFilesFromPageHtml)];

    printMsg(MSG.Run, `[✓] Found ${new Set([...staticJSURLs, ...jsFilesFromPageHtml]).size} JS chunks from page HTML`);

    return new Set([...staticJSURLs, ...jsFilesFromPageHtml]);
};

export default subsequentRequests;
