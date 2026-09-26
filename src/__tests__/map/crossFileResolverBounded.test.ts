import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
    MAX_CACHED_CHUNK_FILES,
    getCrossFileCacheSize,
    substituteCrossFileMarkers,
} from "../../map/vue_js/crossFileResolver.js";

// Many webpack-style chunks: chunk 0 imports a config module that lives in the
// last chunk, so it's evicted from the AST cache by the time it's resolved.
const CHUNK_COUNT = MAX_CACHED_CHUNK_FILES * 4;

const chunkSource = (i: number): string => {
    if (i === 0) {
        return `(self.webpackChunkapp = self.webpackChunkapp || []).push([[0], {
    100(q, M, e) {
        e.r(M);
        const k = e(${CHUNK_COUNT - 1});
        const f = () => k.cfg.baseUrl;
    }
}]);`;
    }
    return `(self.webpackChunkapp = self.webpackChunkapp || []).push([[${i}], {
    ${i}(q, M, e) {
        e.r(M);
        e.d(M, { cfg: () => c });
        const c = { baseUrl: "/api/v${i}", filler: [${Array.from({ length: 50 }, (_, j) => j).join(",")}] };
    }
}]);`;
};

describe("crossFileResolver memory bound", () => {
    let dir: string;

    beforeAll(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "jsr-crossfile-"));
        for (let i = 0; i < CHUNK_COUNT; i++) {
            fs.writeFileSync(path.join(dir, `chunk-${i}.js`), chunkSource(i));
        }
    });

    afterAll(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("keeps the AST cache bounded while still resolving across evicted chunks", () => {
        const out = substituteCrossFileMarkers("[member:k.cfg.baseUrl]/users", path.join(dir, "chunk-0.js"), dir);
        expect(out).toBe(`/api/v${CHUNK_COUNT - 1}/users`);
        expect(getCrossFileCacheSize()).toBeLessThanOrEqual(MAX_CACHED_CHUNK_FILES);
    });
});
