import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
    MAX_CACHED_AST_NODES,
    getCrossFileCacheNodeCount,
    substituteCrossFileMarkers,
} from "../../map/vue_js/crossFileResolver.js";

// Many webpack-style chunks whose combined AST is ~1.5x the node budget: chunk 0
// imports a config module from the last chunk, which may have been evicted by
// the time it's resolved.
const CHUNK_COUNT = 12;
const FILLER_LEN = Math.ceil((MAX_CACHED_AST_NODES * 1.5) / CHUNK_COUNT);

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
        const c = { baseUrl: "/api/v${i}", filler: [${Array.from({ length: FILLER_LEN }, (_, j) => j).join(",")}] };
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
        expect(getCrossFileCacheNodeCount()).toBeGreaterThan(0);
        expect(getCrossFileCacheNodeCount()).toBeLessThanOrEqual(MAX_CACHED_AST_NODES);
    }, 30_000);
});
