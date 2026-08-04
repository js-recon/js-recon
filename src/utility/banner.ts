import { printImage } from "@shriyanss/cli-print-img";
import chalk from "chalk";
import fs from "fs";
import path from "path";
import https from "https";
import os from "os";
import CONFIG from "../globalConfig.js";
import { printMsg, MSG } from "./printMsg.js";

const LOGO_URL = "https://js-recon.io/img/js-recon-logo.png";
const CACHE_DIR = path.join(os.homedir(), ".js-recon");
const LOGO_CACHE = path.join(CACHE_DIR, "logo.png");

function downloadFile(url: string, dest: string): Promise<void> {
    return new Promise((resolve, reject) => {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        const file = fs.createWriteStream(dest);
        https
            .get(url, (res) => {
                if (res.statusCode === 301 || res.statusCode === 302) {
                    file.close();
                    fs.unlinkSync(dest);
                    downloadFile(res.headers.location!, dest).then(resolve).catch(reject);
                    return;
                }
                if (res.statusCode !== 200) {
                    file.close();
                    fs.unlinkSync(dest);
                    reject(new Error(`HTTP ${res.statusCode}`));
                    return;
                }
                res.pipe(file);
                file.on("finish", () => file.close(() => resolve()));
            })
            .on("error", (err) => {
                fs.unlink(dest, () => {});
                reject(err);
            });
    });
}

export async function printBanner(): Promise<void> {
    if (!fs.existsSync(LOGO_CACHE)) {
        try {
            await downloadFile(LOGO_URL, LOGO_CACHE);
        } catch {
            // silently skip logo if download fails
        }
    }

    if (fs.existsSync(LOGO_CACHE)) {
        await printImage(LOGO_CACHE, 45);
    }

    const name = chalk.bold.hex("#00d4ff")("JS Recon");
    const version = chalk.dim(`v${CONFIG.version}`);
    const tagline = chalk.hex("#888888")(CONFIG.toolDesc);
    printMsg(MSG.Plain, `  ${name}  ${version}`);
    printMsg(MSG.Plain, `  ${tagline}`);
    printMsg(MSG.Plain, "");
}
