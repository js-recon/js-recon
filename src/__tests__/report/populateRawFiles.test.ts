import fs from "fs";
import path from "path";
import os from "os";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import initReportDb from "../../report/utility/initReportDb.js";
import populateRawFiles from "../../report/utility/populateDb/populateRawFiles.js";

let temporaryDirectory: string | undefined;

afterEach(() => {
    if (temporaryDirectory) {
        fs.rmSync(temporaryDirectory, { recursive: true, force: true });
        temporaryDirectory = undefined;
    }
});

describe("populateRawFiles", () => {
    it("stores downloaded JS with relative paths and source URLs, skipping other files", async () => {
        temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "js-recon-raw-files-"));
        const jsDir = path.join(temporaryDirectory, "output", "example.test", "static");
        fs.mkdirSync(jsDir, { recursive: true });
        const js = "// File Source: https://example.test/static/app.js\nconsole.log(1);";
        fs.writeFileSync(path.join(jsDir, "app.js"), js);
        fs.writeFileSync(path.join(jsDir, "manifest.json"), "{}");

        const dbPath = path.join(temporaryDirectory, "js-recon.db");
        await initReportDb(dbPath);
        const db = new Database(dbPath);
        await populateRawFiles(db, path.join(temporaryDirectory, "output"), temporaryDirectory);

        const rows = db.prepare("SELECT path, url, content FROM raw_files").all();
        db.close();
        expect(rows).toEqual([
            {
                path: path.join("output", "example.test", "static", "app.js"),
                url: "https://example.test/static/app.js",
                content: js,
            },
        ]);
    });
});
