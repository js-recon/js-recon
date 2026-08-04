import Database from "better-sqlite3";
import { printMsg, MSG } from "../../../utility/printMsg.js";

/**
 * Populates the mapped OpenAPI table in the database with the given OpenAPI data.
 *
 * @param db - The database to populate
 * @param openapi - The OpenAPI data to populate the database with
 *
 * @returns A promise that resolves when the database is populated
 */
const populateMappedOpenapi = async (db: Database.Database, openapi: any) => {
    const insert = db.prepare(
        `INSERT OR REPLACE INTO mapped_openapi (path, method, summary, parameters, requestBody, tags)
         VALUES (@path, @method, @summary, @parameters, @requestBody, @tags)`
    );

    db.transaction(() => {
        if (!openapi.paths) {
            return;
        }

        for (const path in openapi.paths) {
            const methods = openapi.paths[path];
            for (const method in methods) {
                const details = methods[method];
                try {
                    insert.run({
                        path: path,
                        method: method,
                        summary: details.summary || null,
                        parameters: details.parameters ? JSON.stringify(details.parameters) : null,
                        requestBody: details.requestBody ? JSON.stringify(details.requestBody) : null,
                        tags: details.tags ? JSON.stringify(details.tags) : null,
                    });
                } catch (error) {
                    printMsg(MSG.Err, `Error inserting OpenAPI path: ${path} [${method}] - ${error}`);
                }
            }
        }
    })();

    printMsg(MSG.Run, "[✓] Populated mapped openapi into the database...");
};

export default populateMappedOpenapi;
