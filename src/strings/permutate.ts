import fs from "fs";
import { printMsg, MSG } from "../utility/printMsg.js";

/**
 * Permute URLs and paths, and write the results to a .txt file.
 * @param {string[]} urls - The list of URLs to permute
 * @param {string[]} paths - The list of paths to permute
 * @param {string} output - The output file path
 * @returns {Promise<void>} - A promise that resolves when the permutated URLs and paths are written to the output file
 */
const permutate = async (urls: string[], paths: string[], output: string): Promise<void> => {
    printMsg(MSG.Header, "[i] Permutating URLs and paths");

    let permutedUrls = [];

    //   go through each URL
    for (const url of urls) {
        // check if the URL is valid or not by passing to URL
        try {
            new URL(url);
        } catch (err) {
            continue;
        }

        // now that's a valid URL, get the base URL from it
        const baseUrl = new URL(url).origin;

        // go through each path
        for (const path of paths) {
            // join the baseurl and the path, and push it to an array
            permutedUrls.push(new URL(path, baseUrl).href);
        }
    }

    // append all the urls also
    permutedUrls.push(...urls);

    // get the origin aka baseurl, and push those also
    for (const url of urls) {
        try {
            permutedUrls.push(new URL(url).origin);
        } catch {}
    }

    // deduplicate
    permutedUrls = [...new Set(permutedUrls)];

    // write to a .txt file
    const results = permutedUrls.join("\n");
    try {
        fs.writeFileSync(`${output}.txt`, results);
        printMsg(MSG.Run, `[✓] Written permuted URLs to ${output}.txt`);
    } catch (error) {
        printMsg(MSG.Err, `[✗] Failed to write to ${output}.txt: ${error.message}`);
        throw error;
    }
};

export default permutate;
