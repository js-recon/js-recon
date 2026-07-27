import fs from "fs";
import path from "path";
import extract from "extract-zip";
import { printMsg, MSG } from "../../utility/printMsg.js";

/**
 * Downloads and extracts the latest analysis rules from the GitHub repository.
 *
 * Fetches the latest release from the js-recon-rules repository, downloads the zipball,
 * extracts it to the user's home directory, and performs cleanup operations.
 *
 * @param homeDir - The user's home directory path
 * @returns Promise that resolves when rules are downloaded and extracted
 */
const downloadRules = async (homeDir: string): Promise<void> => {
    printMsg(MSG.Header, "[i] Rules not found. Downloading from GitHub...");
    const response = await fetch("https://api.github.com/repos/js-recon/js-recon-rules/releases/latest");
    const release = await response.json();
    const zipballUrl = release.zipball_url;

    const zipPath = path.join(homeDir, "/.js-recon/rules.zip");
    const downloadResponse = await fetch(zipballUrl);

    if (!downloadResponse.ok) {
        throw new Error(`Failed to download rules: ${downloadResponse.statusText}`);
    }

    const arrayBuffer = await downloadResponse.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    fs.writeFileSync(zipPath, buffer);

    printMsg(MSG.Header, "[i] Unzipping rules...");
    const extractPath = path.join(homeDir, "/.js-recon");
    await extract(zipPath, { dir: extractPath });

    // Find the extracted directory
    const files = fs.readdirSync(extractPath);
    const extractedDir = files.find(
        (file) => fs.statSync(path.join(extractPath, file)).isDirectory() && file.startsWith("js-recon-js-recon-rules-")
    );

    if (extractedDir) {
        fs.renameSync(path.join(extractPath, extractedDir), path.join(extractPath, "rules"));
    } else {
        throw new Error("Could not find extracted rules directory.");
    }

    fs.unlinkSync(zipPath); // Clean up the zip file
    // remove the directory .js-recon/rules/.github
    fs.rmSync(path.join(homeDir, "/.js-recon/rules/.github"), { recursive: true });

    // If the release ships a skills/ directory, stage it at ~/.js-recon/skills/.
    const rulesSkillsDir = path.join(homeDir, "/.js-recon/rules/skills");
    const skillsDir = path.join(homeDir, "/.js-recon/skills");
    if (fs.existsSync(rulesSkillsDir)) {
        if (fs.existsSync(skillsDir)) {
            fs.rmSync(skillsDir, { recursive: true });
        }
        fs.renameSync(rulesSkillsDir, skillsDir);
    }

    printMsg(MSG.Run, "[✓] Rules initialized successfully.");
};

/**
 * Initializes the analysis rules system by ensuring rules are available and up-to-date.
 *
 * This function:
 * 1. Creates the .js-recon directory if it doesn't exist
 * 2. Downloads rules if they're missing
 * 3. Validates rule integrity
 * 4. Checks for and downloads rule updates from GitHub
 *
 * @returns Promise that resolves when rules initialization is complete
 */
const initRules = async (): Promise<void> => {
    printMsg(MSG.Header, "[i] Initializing rules...");

    // get the user's home dir
    const homeDir = process.env.HOME;

    // check if the .js-recon directory exists
    if (!fs.existsSync(path.join(homeDir, "/.js-recon"))) {
        fs.mkdirSync(path.join(homeDir, "/.js-recon"));
    }

    // now, check if the rules directory exists
    if (!fs.existsSync(path.join(homeDir, "/.js-recon/rules"))) {
        await downloadRules(homeDir);
    }

    // now that this rule exists, check if the version.txt exists
    const versionPath = path.join(homeDir, "/.js-recon/rules/version.txt");
    if (!fs.existsSync(versionPath)) {
        printMsg(MSG.Warn, "[!] Rules directory is corrupted. Downloading again...");
        // remove the rules directory
        fs.rmSync(path.join(homeDir, "/.js-recon/rules"), { recursive: true });
        await downloadRules(homeDir);
    }

    // also, if the version.txt exist, check if the version.txt is latest as per the latest release on github
    const version = fs.readFileSync(versionPath, "utf8").trim();
    try {
        const response = await fetch("https://api.github.com/repos/js-recon/js-recon-rules/releases/latest");
        const release = await response.json();
        const release_tag_name = release.tag_name;
        if (`v${version}` !== release_tag_name) {
            printMsg(MSG.Warn, "[!] Rules are not up to date. Downloading latest version...");
            // remove the rules directory
            fs.rmSync(path.join(homeDir, "/.js-recon/rules"), { recursive: true });
            await downloadRules(homeDir);
        }
    } catch {
        printMsg(MSG.Err, "[!] An error occured when fetching rules from GitHub");
    }
};

export default initRules;
