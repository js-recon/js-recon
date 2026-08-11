import { describe, it, expect } from "vitest";
import { extractMicroFrontendUrls } from "../../lazyLoad/generic/generic_importMapDiscovery.js";

describe("extractMicroFrontendUrls", () => {
    it("extracts remote-entry URLs from a microFrontends manifest", () => {
        const content = JSON.stringify({
            microFrontends: {
                "@scope/header": [
                    {
                        url: "https://cdn.example.com/mfe/header/1.0.0/abc123/remote-entry.js",
                        metadata: { version: "1.0.0" },
                    },
                ],
                "@scope/footer": [
                    {
                        url: "https://cdn.example.com/mfe/footer/2.0.0/def456/remote-entry.js",
                        metadata: { version: "2.0.0" },
                    },
                ],
            },
        });
        const result = extractMicroFrontendUrls(content).sort();
        expect(result).toEqual([
            "https://cdn.example.com/mfe/footer/2.0.0/def456/remote-entry.js",
            "https://cdn.example.com/mfe/header/1.0.0/abc123/remote-entry.js",
        ]);
    });

    it("strips the // File Source header before parsing", () => {
        const content =
            "// File Source: https://cdn.example.com/importmaps/abc/prod.json\n" +
            JSON.stringify({
                microFrontends: {
                    "@scope/widget": [{ url: "https://cdn.example.com/mfe/widget/remote-entry.js" }],
                },
            });
        expect(extractMicroFrontendUrls(content)).toEqual(["https://cdn.example.com/mfe/widget/remote-entry.js"]);
    });

    it("ignores entries whose url isn't an absolute http(s) .js URL", () => {
        const content = JSON.stringify({
            microFrontends: {
                "@scope/broken": [
                    { url: "/relative/remote-entry.js" },
                    { url: "https://cdn.example.com/mfe/widget/remote-entry.json" },
                    { notUrl: "https://cdn.example.com/mfe/other/remote-entry.js" },
                ],
            },
        });
        expect(extractMicroFrontendUrls(content)).toEqual([]);
    });

    it("dedupes identical URLs across multiple remotes", () => {
        const content = JSON.stringify({
            microFrontends: {
                "@scope/a": [{ url: "https://cdn.example.com/mfe/shared/remote-entry.js" }],
                "@scope/b": [{ url: "https://cdn.example.com/mfe/shared/remote-entry.js" }],
            },
        });
        expect(extractMicroFrontendUrls(content)).toEqual(["https://cdn.example.com/mfe/shared/remote-entry.js"]);
    });

    it("returns [] for content with no microFrontends key", () => {
        expect(extractMicroFrontendUrls(JSON.stringify({ other: "shape" }))).toEqual([]);
    });

    it("returns [] for invalid JSON", () => {
        expect(extractMicroFrontendUrls("not json at all")).toEqual([]);
    });

    it("returns [] for empty content", () => {
        expect(extractMicroFrontendUrls("")).toEqual([]);
    });

    it("returns [] when microFrontends is not an object", () => {
        expect(extractMicroFrontendUrls(JSON.stringify({ microFrontends: "nope" }))).toEqual([]);
    });
});
