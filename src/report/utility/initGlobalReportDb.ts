import Database from "better-sqlite3";

/**
 * Creates the mapped table in the global database. Adds a `domain` column and a
 * `globalId` surrogate key since the original `id` (chunk module id) is only
 * unique within a single domain's bundle, not across domains.
 *
 * @param db - The database to create the table in
 */
const createMappedTable = (db: Database.Database) => {
    db.prepare(
        `
        CREATE TABLE IF NOT EXISTS mapped (
            globalId INTEGER PRIMARY KEY AUTOINCREMENT,
            domain TEXT,
            id TEXT,
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
 * Creates the mapped OpenAPI table in the global database. The primary key is
 * widened to include `domain` since the same path/method can exist on
 * different domains.
 *
 * @param db - The database to create the table in
 */
const createMappedOpenapiTable = (db: Database.Database) => {
    db.prepare(
        `
        CREATE TABLE IF NOT EXISTS mapped_openapi (
            domain TEXT,
            path TEXT,
            method TEXT,
            summary TEXT,
            parameters TEXT,
            requestBody TEXT,
            tags TEXT,
            PRIMARY KEY (domain, path, method)
        )
    `
    ).run();
};

/**
 * Creates the endpoints table in the global database. The primary key is
 * widened to include `domain` since the same URL can exist on different
 * domains.
 *
 * @param db - The database to create the table in
 */
const createEndpointsTable = (db: Database.Database) => {
    db.prepare(
        `
        CREATE TABLE IF NOT EXISTS endpoints (
            domain TEXT,
            url TEXT,
            PRIMARY KEY (domain, url)
        )
    `
    ).run();
};

/**
 * Creates the analysis findings table in the global database. Adds a `domain`
 * column and a `globalId` surrogate key.
 *
 * @param db - The database to create the table in
 */
const createAnalysisFindingsTable = (db: Database.Database) => {
    db.prepare(
        `
        CREATE TABLE IF NOT EXISTS analysis_findings (
            globalId INTEGER PRIMARY KEY AUTOINCREMENT,
            domain TEXT,
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
 * Creates the raw files table in the global database. Adds a `domain` column.
 *
 * @param db - The database to create the table in
 */
const createRawFilesTable = (db: Database.Database) => {
    db.prepare(
        `
        CREATE TABLE IF NOT EXISTS raw_files (
            domain TEXT,
            path TEXT,
            url TEXT,
            content TEXT,
            PRIMARY KEY (domain, path)
        )
    `
    ).run();
};

/**
 * Initializes the global report database used to aggregate the per-domain
 * `js-recon.db` files produced during a batch (`-u <file>`) run.
 *
 * @param sqliteDbPath - The path to the global SQLite database file
 */
const initGlobalReportDb = async (sqliteDbPath: string) => {
    const db = new Database(sqliteDbPath);

    createMappedTable(db);
    createMappedOpenapiTable(db);
    createEndpointsTable(db);
    createAnalysisFindingsTable(db);
    createRawFilesTable(db);

    db.close();
};

export default initGlobalReportDb;
