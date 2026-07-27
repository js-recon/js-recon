import makeRequest from "../../utility/makeReq.js";
import * as cheerio from "cheerio";
import fs from "fs";
import path from "path";
import { printMsg, MSG } from "../../utility/printMsg.js";

const react_getScriptTags = async (url: string, maxJsSizeMb: number, outputDir?: string): Promise<string[]> => {
    let toReturn: string[] = [];

    const req = await makeRequest(url);
    const pageSource = await req.text();

    const $ = cheerio.load(pageSource);
    const host = new URL(url).host.replace(":", "_");
    let inlineIndex = 0;

    $("script").each((_, elem) => {
        const src = $(elem).attr("src");
        if (src) {
            toReturn.push(new URL(src, url).href);
        } else if (outputDir) {
            // Inline script — save to disk so downstream modules can analyze it
            const content = $(elem).text().trim();
            if (!content) return;

            const hostDir = path.join(outputDir, host);
            fs.mkdirSync(hostDir, { recursive: true });
            const filename = `inline-${inlineIndex++}.js`;
            const filePath = path.join(hostDir, filename);
            fs.writeFileSync(filePath, `// File Source: ${url} (inline script #${inlineIndex - 1})\n${content}`);
            printMsg(MSG.Run, `[✓] Saved inline script to ${filePath}`);
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
