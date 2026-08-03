import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as globals from "../../utility/globals.js";

const harness = vi.hoisted(() => ({
    extractSourceMaps: vi.fn<() => Promise<void>>(),
}));

vi.mock("../../lazyLoad/techDetect/index.js", () => ({
    default: vi.fn(async () => ({ name: "react", evidence: "test" })),
}));

vi.mock("../../lazyLoad/react/react_getScriptTags.js", () => ({ default: vi.fn(async () => []) }));
vi.mock("../../lazyLoad/react/react_webpackChunkPaths.js", () => ({ default: vi.fn(async () => []) }));
vi.mock("../../lazyLoad/react/react_followImports.js", () => ({ default: vi.fn(async () => []) }));
vi.mock("../../lazyLoad/react/react_sourcemapUrls.js", () => ({ default: vi.fn(async () => []) }));

vi.mock("../../lazyLoad/downloadQueue.js", () => ({
    DownloadQueue: class MockDownloadQueue {
        progress = {
            processed: 0,
            total: 0,
            downloaded: 0,
            failed: 0,
            ignored: 0,
            failures: { download: 0, invalidResponse: 0, format: 0, write: 0 },
        };
        push(): void {}
        async drain(): Promise<void> {}
        printSummary(): void {}
    },
}));

vi.mock("../../sourcemaps/index.js", () => ({
    extractSourceMaps: harness.extractSourceMaps,
}));

import lazyLoad from "../../lazyLoad/index.js";

beforeEach(() => {
    globals.setDisableCache(true);
});

afterEach(() => {
    globals.setDisableCache(false);
    vi.restoreAllMocks();
});

describe("React source-map extraction lifecycle", () => {
    it("does not resolve lazyload before source-map extraction settles", async () => {
        let resolveExtraction!: () => void;
        harness.extractSourceMaps.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    resolveExtraction = resolve;
                })
        );
        let resolved = false;

        const result = lazyLoad(
            "https://example.test",
            "/tmp/js-recon-sourcemap-await-test",
            true,
            [],
            1,
            false,
            "",
            false,
            false,
            "sourcemaps",
            false,
            "research.json",
            1,
            2,
            0,
            200,
            [],
            [],
            0
        ).then(() => {
            resolved = true;
        });

        await new Promise((resolve) => setImmediate(resolve));
        expect(harness.extractSourceMaps).toHaveBeenCalledTimes(1);
        expect(resolved).toBe(false);

        resolveExtraction();
        await result;
        expect(resolved).toBe(true);
    });
});
