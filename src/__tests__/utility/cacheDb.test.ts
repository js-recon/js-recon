import fs from "fs";
import path from "path";
import os from "os";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { setRespCacheFile } from "../../utility/globals.js";
import {
    closeCacheDb,
    deleteCacheEntry,
    getCacheDb,
    readCacheEntry,
    writeCacheEntryUnsafe,
} from "../../utility/cacheDb.js";

let temporaryCacheDirectory: string | undefined;

const freshCachePath = (): string => {
    temporaryCacheDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "js-recon-cache-db-"));
    const cachePath = path.join(temporaryCacheDirectory, ".resp_cache.db");
    setRespCacheFile(cachePath);
    return cachePath;
};

afterEach(() => {
    closeCacheDb();
    setRespCacheFile(".resp_cache.db");
    if (temporaryCacheDirectory) {
        fs.rmSync(temporaryCacheDirectory, { recursive: true, force: true });
        temporaryCacheDirectory = undefined;
    }
});

describe("cacheDb", () => {
    it("creates the db file and cache_entries table on first open", () => {
        const cachePath = freshCachePath();
        expect(fs.existsSync(cachePath)).toBe(false);
        getCacheDb();
        expect(fs.existsSync(cachePath)).toBe(true);
        const tableCheck = new Database(cachePath, { readonly: true })
            .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='cache_entries'`)
            .get();
        expect(tableCheck).toBeDefined();
    });

    it("reopens when the configured cache file path changes", () => {
        const firstPath = freshCachePath();
        getCacheDb();
        expect(fs.existsSync(firstPath)).toBe(true);

        const secondDir = fs.mkdtempSync(path.join(os.tmpdir(), "js-recon-cache-db-2-"));
        const secondPath = path.join(secondDir, ".resp_cache.db");
        setRespCacheFile(secondPath);
        getCacheDb();
        expect(fs.existsSync(secondPath)).toBe(true);
        fs.rmSync(secondDir, { recursive: true, force: true });
    });

    it("is first-write-wins for a duplicate identity digest (INSERT OR IGNORE)", () => {
        freshCachePath();
        writeCacheEntryUnsafe({
            identityDigest: "digest-a",
            url: "https://example.com/a",
            status: 200,
            statusText: "OK",
            bodyBase64: Buffer.from("first").toString("base64"),
            responseHeaders: { "content-type": "text/plain" },
        });
        writeCacheEntryUnsafe({
            identityDigest: "digest-a",
            url: "https://example.com/a",
            status: 500,
            statusText: "Internal Server Error",
            bodyBase64: Buffer.from("second").toString("base64"),
            responseHeaders: {},
        });

        const entry = readCacheEntry("digest-a");
        expect(entry?.status).toBe(200);
        expect(Buffer.from(entry!.bodyBase64, "base64").toString()).toBe("first");
    });

    it("returns null for an unknown digest (different-target miss)", () => {
        freshCachePath();
        writeCacheEntryUnsafe({
            identityDigest: "digest-target-a",
            url: "https://target-a.example.com/",
            status: 200,
            statusText: "OK",
            bodyBase64: Buffer.from("a").toString("base64"),
            responseHeaders: {},
        });

        expect(readCacheEntry("digest-target-b")).toBeNull();
    });

    it("removes an entry via deleteCacheEntry", () => {
        freshCachePath();
        writeCacheEntryUnsafe({
            identityDigest: "digest-delete",
            url: "https://example.com/delete",
            status: 200,
            statusText: "OK",
            bodyBase64: Buffer.from("x").toString("base64"),
            responseHeaders: {},
        });
        expect(readCacheEntry("digest-delete")).not.toBeNull();
        deleteCacheEntry("digest-delete");
        expect(readCacheEntry("digest-delete")).toBeNull();
    });

    it("allows a clean reopen after closeCacheDb()", () => {
        const cachePath = freshCachePath();
        getCacheDb();
        closeCacheDb();
        expect(() => getCacheDb()).not.toThrow();
        expect(fs.existsSync(cachePath)).toBe(true);
    });

    it("throws from getCacheDb() when the path points to a non-database file", () => {
        temporaryCacheDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "js-recon-cache-db-corrupt-"));
        const corruptPath = path.join(temporaryCacheDirectory, ".resp_cache.db");
        fs.writeFileSync(corruptPath, "not a sqlite database");
        setRespCacheFile(corruptPath);
        expect(() => getCacheDb()).toThrow();
    });
});
