#!/usr/bin/env node
// Auto-installs shell completion on real global installs/upgrades (npm install -g,
// Homebrew, the Docker release image). Never runs for contributor `npm install`/`npm ci`
// inside this repo (npm_config_global is unset/false there). Must never fail the parent
// `npm install` regardless of outcome — all errors are caught and logged, not thrown.

import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const SUPPORTED_SHELLS = new Set(["bash", "zsh", "fish"]);

async function main() {
    if (process.env.npm_config_global !== "true") {
        return;
    }

    const shellPath = process.env.SHELL;
    if (!shellPath) {
        console.log("[i] js-recon: SHELL environment variable not set; skipping automatic completion install.");
        console.log("[i] Run `js-recon completion <bash|zsh|fish>` manually to enable it.");
        return;
    }

    const shell = path.basename(shellPath);
    if (!SUPPORTED_SHELLS.has(shell)) {
        console.log(`[i] js-recon: unsupported shell "${shell}"; skipping automatic completion install.`);
        console.log("[i] Supported shells: bash, zsh, fish. Run `js-recon completion <shell>` manually if applicable.");
        return;
    }

    const here = path.dirname(fileURLToPath(import.meta.url));
    const completionModuleUrl = pathToFileURL(path.join(here, "..", "build", "completion", "index.js"));
    const { default: completion } = await import(completionModuleUrl);
    completion(shell);
}

main().catch((err) => {
    console.error(`[!] js-recon: automatic completion install failed: ${err?.message ?? err}`);
    console.error("[!] Run `js-recon completion <bash|zsh|fish>` manually to enable it.");
});
