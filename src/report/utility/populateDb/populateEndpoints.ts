import Database from "better-sqlite3";
import { printMsg, MSG } from "../../../utility/printMsg.js";

/**
 * Populates the endpoints table in the database with the given endpoints.
 *
 * @param db - The database to populate
 * @param endpoints - The endpoints to populate the database with
 *
 * @returns A promise that resolves when the database is populated
 */
const populateEndpoints = async (db: Database.Database, endpoints: any) => {
    const insert = db.prepare("INSERT OR IGNORE INTO endpoints (url) VALUES (?)");

    // clear the endpoints table
    db.prepare("DELETE FROM endpoints").run();

    const insertPaths = (base: string, paths: object) => {
        for (const path in paths) {
            // The path is the key itself, which is a full path
            const fullUrl = base + path;
            try {
                insert.run(fullUrl);
            } catch (error) {
                // Ignore unique constraint errors if a URL is already present
                if (!error.message.includes("UNIQUE constraint failed")) {
                    printMsg(MSG.Err, `Error inserting ${fullUrl}: ${error}`);
                }
            }

            // Recursively process nested paths
            if (Object.keys(paths[path]).length > 0) {
                insertPaths(base, paths[path]);
            }
        }
    };

    db.transaction(() => {
        for (const baseUrl in endpoints) {
            insertPaths(baseUrl, endpoints[baseUrl]);
        }
    })();

    printMsg(MSG.Run, "[✓] Populated endpoints into the database...");
};

export default populateEndpoints;
