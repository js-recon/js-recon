import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { printMsg, MSG } from "../../../utility/printMsg.js";

/**
 * Populates the raw_files table with the JS files lazyload downloaded, so the database carries
 * the actual files alongside the analysis results. Only files carrying lazyload's
 * `// File Source: <url>` header are stored: in batch mode the download directory is also the
 * target's working directory, so it holds pipeline outputs (mapped.json, js-recon.db, ...) too.
 *
 * @param db - The database to populate
 * @param rawFilesDir - Directory holding the downloaded files (lazyload output)
 * @param baseDir - Directory stored paths are made relative to (the database's directory)
 *
 * @returns A promise that resolves when the database is populated
 */
const populateRawFiles = async (db: Database.Database, rawFilesDir: string, baseDir: string) => {
    if (!fs.existsSync(rawFilesDir)) {
        printMsg(MSG.Warn, `[!] Raw files directory ${rawFilesDir} not found, skipping raw_files`);
        return;
    }

    const insert = db.prepare("INSERT OR REPLACE INTO raw_files (path, url, content) VALUES (?, ?, ?)");

    db.prepare("DELETE FROM raw_files").run();

    let count = 0;
    db.transaction(() => {
        for (const entry of fs.readdirSync(rawFilesDir, { recursive: true, withFileTypes: true })) {
            if (!entry.isFile()) continue;
            const absPath = path.join(entry.parentPath, entry.name);
            const content = fs.readFileSync(absPath, "utf8");
            const url = /^\/\/ File Source: (\S+)/.exec(content)?.[1];
            if (!url) continue;
            insert.run(path.relative(baseDir, absPath), url, content);
            count++;
        }
    })();

    printMsg(MSG.Run, `[✓] Populated ${count} raw files into the database...`);
};

export default populateRawFiles;
