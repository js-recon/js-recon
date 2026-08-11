import Database from "better-sqlite3";
import * as globals from "./globals.js";

/**
 * SQLite-backed response cache. Replaces the legacy whole-file JSON cache
 * (`.resp_cache.json`) and its later sidecar-per-entry JSON format
 * (`<file>.entries/<digest>.json`) with a single `.resp_cache.db` file.
 *
 * One row per identity digest (see `makeReq.ts`'s `getCacheIdentityDigest` —
 * already folds URL + normalized headers, including the RSC-vs-normal
 * distinction, into one hash). No per-target filtering is needed: a
 * different target simply produces a different digest.
 */

export interface CacheRow {
    readonly identityDigest: string;
    readonly url: string;
    readonly status: number;
    readonly statusText: string;
    readonly bodyBase64: string;
    readonly responseHeaders: Readonly<Record<string, string>>;
}

interface CacheEntryTableRow {
    identity_digest: string;
    url: string;
    status: number;
    status_text: string;
    body_base64: string;
    response_headers: string;
}

const createCacheTable = (db: Database.Database): void => {
    db.prepare(
        `
        CREATE TABLE IF NOT EXISTS cache_entries (
            identity_digest   TEXT PRIMARY KEY,
            url               TEXT NOT NULL,
            status            INTEGER NOT NULL,
            status_text       TEXT NOT NULL,
            body_base64       TEXT NOT NULL,
            response_headers  TEXT NOT NULL,
            created_at        TEXT NOT NULL DEFAULT (datetime('now'))
        )
    `
    ).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_cache_entries_url ON cache_entries(url)`).run();
};

let db: Database.Database | null = null;
let dbPath: string | null = null;

/**
 * Returns the singleton cache DB connection, lazily opening (and creating the
 * schema for) `globals.getRespCacheFile()`. Reopens automatically if the
 * configured cache file path has changed since the last call (the CLI sets
 * the path via `setRespCacheFile()` after module import, and tests repoint
 * it per-test).
 */
export const getCacheDb = (): Database.Database => {
    const path = globals.getRespCacheFile();
    if (db && dbPath === path) return db;
    if (db) {
        db.close();
        db = null;
    }
    const opened = new Database(path);
    opened.pragma("journal_mode = WAL");
    createCacheTable(opened);
    db = opened;
    dbPath = path;
    return db;
};

/** Closes the singleton cache DB connection, if open. Safe to call when already closed. */
export const closeCacheDb = (): void => {
    if (db) {
        db.close();
        db = null;
        dbPath = null;
    }
};

const rowToCacheRow = (row: CacheEntryTableRow): CacheRow => ({
    identityDigest: row.identity_digest,
    url: row.url,
    status: row.status,
    statusText: row.status_text,
    bodyBase64: row.body_base64,
    responseHeaders: JSON.parse(row.response_headers),
});

/** Looks up a cache entry by its identity digest. Returns null on miss. */
export const readCacheEntry = (identityDigest: string): CacheRow | null => {
    const row = getCacheDb()
        .prepare(
            `SELECT identity_digest, url, status, status_text, body_base64, response_headers FROM cache_entries WHERE identity_digest = ?`
        )
        .get(identityDigest) as CacheEntryTableRow | undefined;
    return row ? rowToCacheRow(row) : null;
};

/**
 * Inserts a cache entry, first-write-wins for a duplicate identity digest
 * (mirrors the previous sidecar format's "don't clobber an existing entry"
 * behavior, done atomically here instead of via a separate existence check).
 */
export const writeCacheEntryUnsafe = (entry: CacheRow): void => {
    getCacheDb()
        .prepare(
            `INSERT OR IGNORE INTO cache_entries (identity_digest, url, status, status_text, body_base64, response_headers) VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
            entry.identityDigest,
            entry.url,
            entry.status,
            entry.statusText,
            entry.bodyBase64,
            JSON.stringify(entry.responseHeaders)
        );
};

/** Deletes a cache entry by identity digest, e.g. to force a refetch of a blocked response. */
export const deleteCacheEntry = (identityDigest: string): void => {
    getCacheDb().prepare(`DELETE FROM cache_entries WHERE identity_digest = ?`).run(identityDigest);
};
