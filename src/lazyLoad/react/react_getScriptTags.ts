import makeRequest from "../../utility/makeReq.js";
import * as cheerio from "cheerio";
import fs from "fs";
import path from "path";
import chalk from "chalk";
import { resolveHostOutputDirectory } from "../outputPath.js";
import { isRequestCancelled } from "../../utility/makeReq.js";

const react_getScriptTags = async (
    url: string,
    maxJsSizeMb: number,
    outputDir?: string,
    isBatch: boolean = false
): Promise<string[]> => {
    let toReturn: string[] = [];

    const req = await makeRequest(url);
    if (!req || isRequestCancelled()) return [];
    const pageSource = await req.text();

    const $ = cheerio.load(pageSource);
    const hostOutputDir = outputDir ? resolveHostOutputDirectory(outputDir, new URL(url).host, isBatch) : undefined;
    let inlineIndex = 0;

    $("script").each((_, elem) => {
        const src = $(elem).attr("src");
        if (src) {
            toReturn.push(new URL(src, url).href);
        } else if (hostOutputDir) {
            if (isRequestCancelled()) return;
            // Inline script — save to disk so downstream modules can analyze it
            const content = $(elem).text().trim();
            if (!content) return;

            fs.mkdirSync(hostOutputDir, { recursive: true });
            const filename = `inline-${inlineIndex++}.js`;
            const filePath = path.join(hostOutputDir, filename);
            fs.writeFileSync(filePath, `// File Source: ${url} (inline script #${inlineIndex - 1})\n${content}`);
            console.log(chalk.green(`[✓] Saved inline script to ${filePath}`));
        }
    });

    // Vite splits React and other vendor code into chunks referenced via modulepreload links,
    // not script tags. Include them as seeds so import-following picks them up.
    $("link[rel='modulepreload']").each((_, elem) => {
        const href = $(elem).attr("href");
        if (href) {
            toReturn.push(new URL(href, url).href);
        }
    });

    toReturn = [...new Set(toReturn)];
    return toReturn;
};

export default react_getScriptTags;
