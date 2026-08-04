import { Chunks } from "../../../utility/interfaces.js";
import { printMsg, MSG } from "../../../utility/printMsg.js";
import Database from "better-sqlite3";

/**
 * Populates the mapped JSON table in the database with the given chunks.
 *
 * @param db - The database to populate
 * @param chunks - The chunks to populate the database with
 *
 * @returns A promise that resolves when the database is populated
 */
export const populateMappedJson = async (db: Database.Database, chunks: Chunks) => {
    // Clear the table before inserting new data
    db.prepare(`DELETE FROM mapped`).run();

    const insert = db.prepare(
        `INSERT INTO mapped (id, description, loadedOn, containsFetch, isAxiosClient, exports, callStack, code, imports, file) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    const insertMany = db.transaction((items) => {
        for (const item of items) {
            insert.run(
                item.id,
                item.description,
                JSON.stringify(item.loadedOn),
                item.containsFetch ? 1 : 0,
                item.isAxiosClient ? 1 : 0,
                JSON.stringify(item.exports),
                JSON.stringify(item.callStack),
                item.code,
                JSON.stringify(item.imports),
                item.file
            );
        }
    });

    insertMany(Object.values(chunks));
    printMsg(MSG.Run, "[✓] Populated mapped data into the database...");
};
