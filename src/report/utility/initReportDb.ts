import Database from "better-sqlite3";

/**
 * Creates the mapped table in the database.
 *
 * @param db - The database to create the table in
 */
const createMappedTable = (db: Database.Database) => {
    db.prepare(
        `
        CREATE TABLE IF NOT EXISTS mapped (
            id TEXT PRIMARY KEY,
            description TEXT,
            loadedOn TEXT,
            containsFetch BOOLEAN,
            isAxiosClient BOOLEAN,
            exports TEXT,
            callStack TEXT,
            code TEXT,
            imports TEXT,
            file TEXT
        )
    `
    ).run();
};

/**
 * Creates the mapped OpenAPI table in the database.
 *
 * @param db - The database to create the table in
 */
const createMappedOpenapiTable = (db: Database.Database) => {
    db.prepare(
        `
        CREATE TABLE IF NOT EXISTS mapped_openapi (
            path TEXT,
            method TEXT,
            summary TEXT,
            parameters TEXT,
            requestBody TEXT,
            tags TEXT,
            PRIMARY KEY (path, method)
        )
    `
    ).run();
};

/**
 * Creates the endpoints table in the database.
 *
 * @param db - The database to create the table in
 */
const createEndpointsTable = (db: Database.Database) => {
    db.prepare(
        `
        CREATE TABLE IF NOT EXISTS endpoints (
            url TEXT PRIMARY KEY
        )
    `
    ).run();
};

/**
 * Creates the analysis findings table in the database.
 *
 * @param db - The database to create the table in
 */
const createAnalysisFindingsTable = (db: Database.Database) => {
    db.prepare(
        `
        CREATE TABLE IF NOT EXISTS analysis_findings (
            ruleId TEXT,
            ruleName TEXT,
            ruleType TEXT,
            ruleDescription TEXT,
            ruleAuthor TEXT,
            ruleTech TEXT,
            severity TEXT,
            message TEXT,
            findingLocation TEXT
        )
    `
    ).run();
};

/**
 * Creates the raw files table in the database, which stores the downloaded files so the
 * database can be shared as a self-contained session export.
 *
 * @param db - The database to create the table in
 */
const createRawFilesTable = (db: Database.Database) => {
    db.prepare(
        `
        CREATE TABLE IF NOT EXISTS raw_files (
            path TEXT PRIMARY KEY,
            url TEXT,
            content TEXT
        )
    `
    ).run();
};

/**
 * Initializes the report database.
 *
 * @param sqliteDbPath - The path to the SQLite database file
 */
const initReportDb = async (sqliteDbPath: string) => {
    const db = new Database(sqliteDbPath);

    createMappedTable(db);
    createMappedOpenapiTable(db);
    createEndpointsTable(db);
    createAnalysisFindingsTable(db);
    createRawFilesTable(db);

    db.close();
};

export default initReportDb;
