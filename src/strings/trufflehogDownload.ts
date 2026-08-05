import fs from "fs";
import path from "path";
import * as tar from "tar";
import { withActiveProxyDispatcher, type FetchOptsWithDispatcher } from "../utility/makeReq.js";
import { printMsg, MSG } from "../utility/printMsg.js";

const TRUFFLEHOG_RELEASE_URL = "https://api.github.com/repos/trufflesecurity/trufflehog/releases/latest";

/**
 * Maps Node's platform/arch identifiers to TruffleHog's GitHub release asset naming
 * (e.g. `trufflehog_3.96.0_darwin_amd64.tar.gz`).
 *
 * @param platform - `process.platform` value
 * @param arch - `process.arch` value
 * @returns The `<os>_<arch>` fragment used in TruffleHog's release asset names
 */
export const resolveAssetName = (platform: NodeJS.Platform, arch: string): string => {
    const osMap: Partial<Record<NodeJS.Platform, string>> = {
        darwin: "darwin",
        linux: "linux",
        win32: "windows",
    };
    const archMap: Record<string, string> = {
        x64: "amd64",
        arm64: "arm64",
    };

    const os = osMap[platform];
    const mappedArch = archMap[arch];
    if (!os || !mappedArch) {
        throw new Error(`Unsupported platform/arch for TruffleHog auto-download: ${platform}/${arch}`);
    }

    return `${os}_${mappedArch}`;
};

interface TrufflehogRelease {
    readonly tagName: string;
    readonly downloadUrl: string;
}

const fetchLatestTrufflehogRelease = async (options: FetchOptsWithDispatcher): Promise<TrufflehogRelease> => {
    const response = await fetch(TRUFFLEHOG_RELEASE_URL, options);
    if (!response.ok) {
        throw new Error(`TruffleHog release lookup failed with HTTP ${response.status}`);
    }

    const release = (await response.json()) as unknown;
    if (typeof release !== "object" || release === null) {
        throw new Error("TruffleHog release response was not an object");
    }
    const { tag_name: tagName, assets } = release as Record<string, unknown>;
    if (typeof tagName !== "string" || !Array.isArray(assets)) {
        throw new Error("TruffleHog release response is missing tag_name or assets");
    }

    const assetSuffix = resolveAssetName(process.platform, process.arch);
    const asset = assets.find(
        (a): a is Record<string, unknown> =>
            typeof a === "object" &&
            a !== null &&
            typeof (a as Record<string, unknown>).name === "string" &&
            ((a as Record<string, unknown>).name as string).includes(assetSuffix) &&
            ((a as Record<string, unknown>).name as string).endsWith(".tar.gz")
    );
    if (!asset || typeof asset.browser_download_url !== "string") {
        throw new Error(`No TruffleHog release asset found for platform/arch "${assetSuffix}"`);
    }

    const parsedUrl = new URL(asset.browser_download_url);
    if (
        parsedUrl.protocol !== "https:" ||
        !["github.com", "objects.githubusercontent.com"].includes(parsedUrl.hostname)
    ) {
        throw new Error("TruffleHog release response contains an unexpected download URL");
    }

    return Object.freeze({ tagName, downloadUrl: parsedUrl.toString() });
};

/**
 * Downloads and caches the TruffleHog binary from its official GitHub releases.
 *
 * Fetches the latest release directly from `trufflesecurity/trufflehog` and extracts the
 * platform-matching binary under `~/.js-recon/trufflehog/<version>/`. JS Recon never mirrors
 * or hosts its own copy of the binary — every download resolves the asset URL from GitHub's
 * release API at request time.
 *
 * @param homeDir - The user's home directory path
 * @returns Absolute path to the cached (or freshly downloaded) trufflehog binary
 */
export const downloadTrufflehog = async (homeDir: string): Promise<string> => {
    const trufflehogRoot = path.join(homeDir, ".js-recon", "trufflehog");
    const binName = process.platform === "win32" ? "trufflehog.exe" : "trufflehog";

    if (fs.existsSync(trufflehogRoot)) {
        const cachedVersionDirs = fs.readdirSync(trufflehogRoot);
        for (const versionDir of cachedVersionDirs) {
            const cachedBin = path.join(trufflehogRoot, versionDir, binName);
            if (fs.existsSync(cachedBin)) {
                return cachedBin;
            }
        }
    }

    printMsg(MSG.Header, "[i] TruffleHog not found. Downloading from GitHub...");
    const buffer = await withActiveProxyDispatcher(async (options) => {
        const release = await fetchLatestTrufflehogRelease(options);
        const downloadResponse = await fetch(release.downloadUrl, options);
        if (!downloadResponse.ok) {
            throw new Error(`Failed to download TruffleHog: ${downloadResponse.statusText}`);
        }
        return { buffer: Buffer.from(await downloadResponse.arrayBuffer()), tagName: release.tagName };
    });

    const version = buffer.tagName.replace(/^v/, "");
    const extractPath = path.join(trufflehogRoot, version);
    fs.mkdirSync(extractPath, { recursive: true });

    const tarPath = path.join(extractPath, "trufflehog.tar.gz");
    fs.writeFileSync(tarPath, buffer.buffer);

    printMsg(MSG.Header, "[i] Extracting TruffleHog...");
    await tar.x({ file: tarPath, cwd: extractPath });
    fs.unlinkSync(tarPath);

    const binPath = path.join(extractPath, binName);
    fs.chmodSync(binPath, 0o755);

    printMsg(MSG.Run, "[✓] TruffleHog downloaded successfully.");
    return binPath;
};
