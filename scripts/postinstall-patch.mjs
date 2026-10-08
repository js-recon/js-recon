#!/usr/bin/env node
// Makes puppeteer-extra-plugin-user-data-dir@2.4.1 work with the rimraf@6 override: rimraf@6 dropped the
// callback API, so its temp profile cleanup is switched to fs.rm. Replaces patch-package, whose
// micromatch -> braces chain has no patched release. Idempotent; must never fail the parent `npm install`.

import fs from "fs";
import { createRequire } from "module";

try {
    const file = createRequire(import.meta.url).resolve("puppeteer-extra-plugin-user-data-dir");
    const source = fs.readFileSync(file, "utf8");
    if (source.includes("require('rimraf')")) {
        const patched = source
            .replace("const rimraf = require('rimraf')\n", "")
            .replace("    rimraf(\n", "    fs.rm(\n")
            .replace("maxBusyTries: 4", "recursive: true,\n        force: true,\n        maxRetries: 4");
        fs.writeFileSync(file, patched);
    }
} catch (err) {
    console.log(`[!] js-recon: could not patch puppeteer-extra-plugin-user-data-dir: ${err.message}`);
}
