import fs from "fs";
import path from "path";
import * as tar from "tar";
import { withActiveProxyDispatcher, type FetchOptsWithDispatcher } from "../../utility/makeReq.js";
import { printMsg, MSG } from "../../utility/printMsg.js";

/** A GitHub repo whose latest release is cached at `~/.js-recon/<dir>`, checked against its `version.txt`. */
interface Pack {
    readonly repo: string;
    readonly dir: string;
    readonly label: string;
}

const RULES: Pack = { repo: "js-recon-rules", dir: "rules", label: "Rules" };
const TAINTWIRE_QUERIES: Pack = { repo: "taintwire-queries", dir: "taintwire-queries", label: "taintwire queries" };

const latestReleaseApiUrl = (pack: Pack) => `https://api.github.com/repos/js-recon/${pack.repo}/releases/latest`;

interface RulesRelease {
    readonly tagName: string;
    readonly tarballUrl: string;
}

const fetchLatestRulesRelease = async (pack: Pack, options: FetchOptsWithDispatcher): Promise<RulesRelease> => {
    const RULES_RELEASE_URL = latestReleaseApiUrl(pack);
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

    const releaseUrl = new URL(RULES_RELEASE_URL);
    const repositoryPath = releaseUrl.pathname.replace(/\/releases\/latest$/, "");
    const parsedTarballUrl = new URL(tarballUrl);
    if (
        parsedTarballUrl.protocol !== "https:" ||
        parsedTarballUrl.origin !== releaseUrl.origin ||
        !parsedTarballUrl.pathname.startsWith(`${repositoryPath}/tarball/`)
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
const downloadRules = async (homeDir: string, pack: Pack): Promise<void> => {
    printMsg(MSG.Header, `[i] ${pack.label} not found. Downloading from GitHub...`);
    const buffer = await withActiveProxyDispatcher(async (options) => {
        const release = await fetchLatestRulesRelease(pack, options);
        const downloadResponse = await fetch(release.tarballUrl, options);

        if (!downloadResponse.ok) {
            throw new Error(`Failed to download ${pack.label}: ${downloadResponse.statusText}`);
        }
        return Buffer.from(await downloadResponse.arrayBuffer());
    });

    const tarPath = path.join(homeDir, `/.js-recon/${pack.dir}.tar.gz`);
    fs.writeFileSync(tarPath, buffer);

    printMsg(MSG.Header, `[i] Extracting ${pack.label}...`);
    const extractPath = path.join(homeDir, "/.js-recon");
    await tar.x({ file: tarPath, cwd: extractPath });

    // Find the extracted directory
    const files = fs.readdirSync(extractPath);
    const extractedDir = files.find(
        (file) => fs.statSync(path.join(extractPath, file)).isDirectory() && file.startsWith(`js-recon-${pack.repo}-`)
    );

    if (extractedDir) {
        fs.renameSync(path.join(extractPath, extractedDir), path.join(extractPath, pack.dir));
    } else {
        throw new Error(`Could not find extracted ${pack.label} directory.`);
    }

    fs.unlinkSync(tarPath); // Clean up the downloaded tarball
    fs.rmSync(path.join(extractPath, pack.dir, ".github"), { recursive: true, force: true });
    if (pack !== RULES) {
        printMsg(MSG.Run, `[✓] ${pack.label} initialized successfully.`);
        return;
    }

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
const initPack = async (pack: Pack, disableVersionCheck: boolean): Promise<void> => {
    printMsg(MSG.Header, `[i] Initializing ${pack.label}...`);

    // get the user's home dir
    const homeDir = process.env.HOME;

    // check if the .js-recon directory exists
    if (!fs.existsSync(path.join(homeDir, "/.js-recon"))) {
        fs.mkdirSync(path.join(homeDir, "/.js-recon"));
    }

    const rulesDir = path.join(homeDir, "/.js-recon", pack.dir);
    if (
        shouldSkipRulesVersionCheck(
            disableVersionCheck,
            process.env.JS_RECON_DISABLE_RULES_VERSION_CHECK,
            fs.existsSync(rulesDir)
        )
    ) {
        printMsg(MSG.Header, `[i] ${pack.label} version check disabled — using cached ${pack.label} as-is.`);
        return;
    }

    // now, check if the rules directory exists
    if (!fs.existsSync(path.join(homeDir, "/.js-recon", pack.dir))) {
        await downloadRules(homeDir, pack);
    }

    // now that this rule exists, check if the version.txt exists
    const versionPath = path.join(homeDir, "/.js-recon", pack.dir, "version.txt");
    if (!fs.existsSync(versionPath)) {
        printMsg(MSG.Warn, `[!] ${pack.label} directory is corrupted. Downloading again...`);
        // remove the rules directory
        fs.rmSync(path.join(homeDir, "/.js-recon", pack.dir), { recursive: true });
        await downloadRules(homeDir, pack);
    }

    // also, if the version.txt exist, check if the version.txt is latest as per the latest release on github
    const version = fs.readFileSync(versionPath, "utf8").trim();
    try {
        const release = await withActiveProxyDispatcher((options) => fetchLatestRulesRelease(pack, options));
        if (`v${version}` !== release.tagName) {
            printMsg(MSG.Warn, `[!] ${pack.label} are not up to date. Downloading latest version...`);
            // remove the rules directory
            fs.rmSync(path.join(homeDir, "/.js-recon", pack.dir), { recursive: true });
            await downloadRules(homeDir, pack);
        }
    } catch {
        printMsg(MSG.Err, `[!] An error occurred when fetching ${pack.label} from GitHub`);
    }
};

const initRules = (disableVersionCheck: boolean = false): Promise<void> => initPack(RULES, disableVersionCheck);

/** Like initRules, for the taintwire-queries pack at `~/.js-recon/taintwire-queries`. */
export const initTaintwireQueries = (disableVersionCheck: boolean = false): Promise<void> =>
    initPack(TAINTWIRE_QUERIES, disableVersionCheck);

export default initRules;
