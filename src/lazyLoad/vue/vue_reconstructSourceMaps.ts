import makeRequest from "../../utility/makeReq.js";
import chalk from "chalk";
import { runWithConcurrency } from "../../utility/concurrency.js";

const vue_reconstructSourceMaps = async (url: string, jsFilesToDownload: string[], threads: number = 1) => {
    // get the contents of first file, and check if it has the sourceMappingURL

    let sourceMapUrls: string[] = [];
    // guard against empty input
    if (jsFilesToDownload.length === 0) {
        return sourceMapUrls;
    }

    const req = await makeRequest(jsFilesToDownload[0]);
    if (req == null) {
        console.error(chalk.red(`Failed to fetch ${jsFilesToDownload[0]}`));
        return sourceMapUrls;
    }
    const content = await req.text();

    // check if it has the sourceMappingURL
    if (!(content.includes("sourceMappingURL=") || content.includes("sourceMappingURL ="))) {
        return sourceMapUrls;
    }

    console.log(chalk.green("[✓] Found sourceMappingURL"));

    // now that one file has this, iterate through all the files, and reconstruct the source maps
    await runWithConcurrency(jsFilesToDownload, threads, async (jsFile) => {
        const req = await makeRequest(jsFile);
        if (req == null) {
            console.error(chalk.red(`Failed to fetch ${jsFile}`));
            return;
        }
        const content = await req.text();

        // get the sourceMappingURL
        let sourceMappingURL_reg = content.match(/sourceMappingURL=([^"]+)/);
        if (sourceMappingURL_reg) {
            // strip the newline, and assign to a new var
            const sourceMappingURL = sourceMappingURL_reg[1].replace(/\n/g, "");

            // reconstruct the URL
            let reconstructedUrl: string = "";
            if (sourceMappingURL.startsWith("/")) {
                reconstructedUrl = new URL(jsFile).origin + sourceMappingURL;
            } else if (sourceMappingURL.startsWith("./")) {
                reconstructedUrl = new URL(sourceMappingURL, jsFile).href;
            } else if (sourceMappingURL.startsWith("http")) {
                reconstructedUrl = sourceMappingURL;
            } else {
                reconstructedUrl = new URL(sourceMappingURL, jsFile).href;
            }

            // now that we've got the mapping URL, just push it to the array
            sourceMapUrls.push(reconstructedUrl);
        }
    });

    return sourceMapUrls;
};

export default vue_reconstructSourceMaps;
