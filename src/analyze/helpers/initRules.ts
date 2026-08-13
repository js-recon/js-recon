import fs from "fs";
import path from "path";
import * as tar from "tar";
import { withActiveProxyDispatcher, type FetchOptsWithDispatcher } from "../../utility/makeReq.js";
import { printMsg, MSG } from "../../utility/printMsg.js";

const RULES_RELEASE_URL = "https://api.github.com/repos/js-recon/js-recon-rules/releases/latest";

interface RulesRelease {
    readonly tagName: string;
    readonly tarballUrl: string;
}

const fetchLatestRulesRelease = async (options: FetchOptsWithDispatcher): Promise<RulesRelease> => {
    const response = await fetch(RULES_RELEASE_URL, options);
    if (!response.ok) {
        throw new Error(`Rules release lookup failed with HTTP ${response.status}`);
    }

    const release = (await response.json()) as unknown;
    if (typeof release !== "object" || release === null) {
        throw new Error("Rules release response was not an object");
    }
    const { tag_name: tagName, tarball_url: tarballUrl } = release as Record<string, unknown>;
    if (typeof tagName !== "string" || typeof tarballUrl !== "string") {
        throw new Error("Rules release response is missing tag_name or tarball_url");
    }

    const parsedTarballUrl = new URL(tarballUrl);
    if (
        parsedTarballUrl.protocol !== "https:" ||
        parsedTarballUrl.hostname !== "api.github.com" ||
        !parsedTarballUrl.pathname.startsWith("/repos/js-recon/js-recon-rules/tarball/")
    ) {
        throw new Error("Rules release response contains an unexpected tarball URL");
    }
    return Object.freeze({ tagName, tarballUrl: parsedTarballUrl.toString() });
};

/**
 * Downloads and extracts the latest analysis rules from the GitHub repository.
 *
 * Fetches the latest release from the js-recon-rules repository, downloads the tarball,
 * extracts it to the user's home directory, and performs cleanup operations.
 *
 * @param homeDir - The user's home directory path
 * @returns Promise that resolves when rules are downloaded and extracted
 */
const downloadRules = async (homeDir: string): Promise<void> => {
    printMsg(MSG.Header, "[i] Rules not found. Downloading from GitHub...");
    const buffer = await withActiveProxyDispatcher(async (options) => {
        const release = await fetchLatestRulesRelease(options);
        const downloadResponse = await fetch(release.tarballUrl, options);

        if (!downloadResponse.ok) {
            throw new Error(`Failed to download rules: ${downloadResponse.statusText}`);
        }
        return Buffer.from(await downloadResponse.arrayBuffer());
    });

    const tarPath = path.join(homeDir, "/.js-recon/rules.tar.gz");
    fs.writeFileSync(tarPath, buffer);

    printMsg(MSG.Header, "[i] Extracting rules...");
    const extractPath = path.join(homeDir, "/.js-recon");
    await tar.x({ file: tarPath, cwd: extractPath });

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

    fs.unlinkSync(tarPath); // Clean up the downloaded tarball
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
 * Determines whether the GitHub rules version check should be skipped.
 *
 * The check is only skipped when explicitly disabled (via the `--disable-rules-version-check`
 * flag or the `JS_RECON_DISABLE_RULES_VERSION_CHECK` env var) AND rules are already cached
 * locally — if the rules directory doesn't exist yet, the tool still needs to fetch them
 * from GitHub at least once.
 *
 * @param disableFlag - Value of the `--disable-rules-version-check` CLI flag
 * @param envValue - Value of the `JS_RECON_DISABLE_RULES_VERSION_CHECK` env var
 * @param rulesDirExists - Whether `~/.js-recon/rules` already exists
 * @returns Whether the version check should be skipped
 */
export const shouldSkipRulesVersionCheck = (
    disableFlag: boolean,
    envValue: string | undefined,
    rulesDirExists: boolean
): boolean => (disableFlag || envValue === "true") && rulesDirExists;

/**
 * Initializes the analysis rules system by ensuring rules are available and up-to-date.
 *
 * This function:
 * 1. Creates the .js-recon directory if it doesn't exist
 * 2. Downloads rules if they're missing
 * 3. Validates rule integrity
 * 4. Checks for and downloads rule updates from GitHub (unless skipped, see `shouldSkipRulesVersionCheck`)
 *
 * @param disableVersionCheck - Skip the GitHub version check and use cached rules as-is
 * @returns Promise that resolves when rules initialization is complete
 */
const initRules = async (disableVersionCheck: boolean = false): Promise<void> => {
    printMsg(MSG.Header, "[i] Initializing rules...");

    // get the user's home dir
    const homeDir = process.env.HOME;

    // check if the .js-recon directory exists
    if (!fs.existsSync(path.join(homeDir, "/.js-recon"))) {
        fs.mkdirSync(path.join(homeDir, "/.js-recon"));
    }

    const rulesDir = path.join(homeDir, "/.js-recon/rules");
    if (
        shouldSkipRulesVersionCheck(
            disableVersionCheck,
            process.env.JS_RECON_DISABLE_RULES_VERSION_CHECK,
            fs.existsSync(rulesDir)
        )
    ) {
        printMsg(MSG.Header, "[i] Rules version check disabled — using cached rules as-is.");
        return;
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
        const release = await withActiveProxyDispatcher(fetchLatestRulesRelease);
        if (`v${version}` !== release.tagName) {
            printMsg(MSG.Warn, "[!] Rules are not up to date. Downloading latest version...");
            // remove the rules directory
            fs.rmSync(path.join(homeDir, "/.js-recon/rules"), { recursive: true });
            await downloadRules(homeDir);
        }
    } catch {
        printMsg(MSG.Err, "[!] An error occurred when fetching rules from GitHub");
    }
};

export default initRules;
