import Database from "better-sqlite3";

/**
 * Merges a single domain's fully-populated `js-recon.db` into the batch-wide
 * global database, tagging every copied row with `domain` so it can be
 * traced back to its source directory. Uses `ATTACH DATABASE` so rows are
 * copied directly via SQL instead of re-reading the domain's JSON inputs.
 *
 * @param globalDbPath - Path to the global SQLite database file
 * @param domainDbPath - Path to the domain's own `js-recon.db`
 * @param domain - The domain identifier (sanitized host) to tag rows with
 */
const mergeDomainIntoGlobalDb = (globalDbPath: string, domainDbPath: string, domain: string) => {
    const db = new Database(globalDbPath);

    try {
        db.prepare(`ATTACH DATABASE ? AS src`).run(domainDbPath);

        db.prepare(
            `
            INSERT INTO mapped (domain, id, description, loadedOn, containsFetch, isAxiosClient, exports, callStack, code, imports, file)
            SELECT ?, id, description, loadedOn, containsFetch, isAxiosClient, exports, callStack, code, imports, file FROM src.mapped
        `
        ).run(domain);

        db.prepare(
            `
            INSERT OR REPLACE INTO mapped_openapi (domain, path, method, summary, parameters, requestBody, tags)
            SELECT ?, path, method, summary, parameters, requestBody, tags FROM src.mapped_openapi
        `
        ).run(domain);

        db.prepare(
            `
            INSERT OR IGNORE INTO endpoints (domain, url)
            SELECT ?, url FROM src.endpoints
        `
        ).run(domain);

        db.prepare(
            `
            INSERT INTO analysis_findings (domain, ruleId, ruleName, ruleType, ruleDescription, ruleAuthor, ruleTech, severity, message, findingLocation)
            SELECT ?, ruleId, ruleName, ruleType, ruleDescription, ruleAuthor, ruleTech, severity, message, findingLocation FROM src.analysis_findings
        `
        ).run(domain);

        db.prepare(
            `
            INSERT OR REPLACE INTO raw_files (domain, path, url, content)
            SELECT ?, path, url, content FROM src.raw_files
        `
        ).run(domain);

        db.prepare(`DETACH DATABASE src`).run();
    } finally {
        db.close();
    }
};

export default mergeDomainIntoGlobalDb;
