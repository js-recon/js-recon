import path from "path";
import { describe, expect, it } from "vitest";
import {
    getSanitizedAssetFilename,
    resolveAssetOutputDirectory,
    resolveHostOutputDirectory,
    sanitizeOutputPathSegment,
    toOutputHost,
} from "../../lazyLoad/outputPath.js";

describe("resolveHostOutputDirectory", () => {
    it("does not append a target host already owned by the output root", () => {
        expect(resolveHostOutputDirectory("/home/pptruser/output/js-recon.io", "js-recon.io")).toBe(
            "/home/pptruser/output/js-recon.io"
        );
    });

    it("keeps a distinct CDN host inside the target output root", () => {
        expect(resolveHostOutputDirectory("/home/pptruser/output/js-recon.io", "cdn.example.test")).toBe(
            "/home/pptruser/output/js-recon.io/cdn.example.test"
        );
    });

    it("sanitizes host ports consistently", () => {
        expect(resolveHostOutputDirectory("output", "example.test:8443")).toBe(
            path.join("output", toOutputHost("example.test:8443"))
        );
    });

    it("normalizes every IPv6 separator consistently", () => {
        const outputHost = toOutputHost("[::1]:3000");
        expect(outputHost).not.toContain(":");
        expect(resolveHostOutputDirectory(`/tmp/output/${outputHost}`, "[::1]:3000")).toBe(`/tmp/output/${outputHost}`);
    });
});

describe("resolveAssetOutputDirectory", () => {
    it("preserves the URL directory without duplicating an owned host", () => {
        expect(
            resolveAssetOutputDirectory(
                "/home/pptruser/output/js-recon.io",
                "https://js-recon.io/assets/assets/js/119794d4.c34b46d3.js"
            )
        ).toBe("/home/pptruser/output/js-recon.io/assets/assets/js");
    });

    it("mirrors host and path below a generic output root", () => {
        expect(resolveAssetOutputDirectory("output", "https://example.test/static/js/app.js")).toBe(
            path.join("output", "example.test", "static", "js")
        );
    });

    it("contains dot-host URLs within the configured output root", () => {
        const outputRoot = "/tmp/js-recon-safe-output";
        const result = resolveAssetOutputDirectory(outputRoot, "https://../evil.js");
        const relative = path.relative(outputRoot, result);

        expect(relative).not.toBe("..");
        expect(relative.startsWith(`..${path.sep}`)).toBe(false);
        expect(path.isAbsolute(relative)).toBe(false);
    });

    it("sanitizes JavaScript-expression fragments embedded in URL directories", () => {
        const resourceUrl =
            "https://vercel.live/_next-live/feedback/'.concat(P.bd,'/_next-live/feedback/instrument.9431cd64d88c76a5bd6b.js";

        const result = resolveAssetOutputDirectory("/home/pptruser/output/ss0x00.com", resourceUrl);

        expect(result).toContain("/vercel.live/_next-live/feedback/__jsr_encoded_");
        expect(result).toMatch(/^[a-zA-Z0-9_./~-]+$/);
        expect(result).not.toContain("'.concat(P.bd,'");
        expect(getSanitizedAssetFilename(resourceUrl)).toBe("instrument.9431cd64d88c76a5bd6b.js");
    });

    it("keeps distinct unsafe segments and query-specific assets collision-safe", () => {
        const encodedUnsafeSegment = sanitizeOutputPathSegment("a:b");
        expect(encodedUnsafeSegment).not.toBe(sanitizeOutputPathSegment("a*b"));
        expect(sanitizeOutputPathSegment(encodedUnsafeSegment)).not.toBe(encodedUnsafeSegment);
        expect(getSanitizedAssetFilename("https://example.test/app.js?v=1")).not.toBe(
            getSanitizedAssetFilename("https://example.test/app.js?v=2")
        );
        const encodedUnsafeFilename = getSanitizedAssetFilename("https://example.test/a:b.js")!;
        expect(getSanitizedAssetFilename(`https://example.test/${encodedUnsafeFilename}`)).not.toBe(
            encodedUnsafeFilename
        );
    });

    it("keeps long sanitized filenames bounded while preserving their extension", () => {
        const resourceUrl = `https://example.test/assets/${"a".repeat(300)} name.js`;
        const filename = getSanitizedAssetFilename(resourceUrl);

        expect(filename).toMatch(/\.js$/);
        expect(filename?.length).toBeLessThanOrEqual(180);
        expect(filename).not.toContain(" ");
    });

    it("keeps a synthetic empty basename distinct from a literal asset basename", () => {
        expect(getSanitizedAssetFilename("https://example.test/.js")).not.toBe(
            getSanitizedAssetFilename("https://example.test/asset.js")
        );
    });
});
