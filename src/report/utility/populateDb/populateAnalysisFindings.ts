import { EngineOutput } from "../../../analyze/helpers/outputHelper.js";
import { printMsg, MSG } from "../../../utility/printMsg.js";
import Database from "better-sqlite3";

/**
 * Populates the analysis findings table in the database with the given findings.
 *
 * @param db - The database to populate
 * @param findings - The findings to populate the database with
 *
 * @returns A promise that resolves when the database is populated
 */
export const populateAnalysisFindings = async (db: Database.Database, findings: EngineOutput[]) => {
    // Clear the table before inserting new data
    db.prepare(`DELETE FROM analysis_findings`).run();

    const insert = db.prepare(
        `INSERT INTO analysis_findings (ruleId, ruleName, ruleType, ruleDescription, ruleAuthor, ruleTech, severity, message, findingLocation) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    const insertMany = db.transaction((items) => {
        for (const item of items) {
            insert.run(
                item.ruleId,
                item.ruleName,
                item.ruleType,
                item.ruleDescription,
                item.ruleAuthor,
                Array.isArray(item.ruleTech) ? item.ruleTech.join(",") : item.ruleTech,
                item.severity,
                item.message,
                item.findingLocation
            );
        }
    });

    insertMany(findings);
    printMsg(MSG.Run, "[✓] Populated analysis findings into the database...");
};
