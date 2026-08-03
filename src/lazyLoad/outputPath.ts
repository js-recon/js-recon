import path from "path";
import { createHash } from "node:crypto";
import { getURLDirectory, toOutputHost } from "../utility/urlUtils.js";

export { toOutputHost } from "../utility/urlUtils.js";

const MAX_DIRECTORY_SEGMENT_LENGTH = 120;
const MAX_FILENAME_LENGTH = 180;
const ASSET_EXTENSION = /(\.mjs\.map|\.js\.map|\.mjs|\.json|\.js|\.vue)$/i;
const ENCODED_SEGMENT_PREFIX = "__jsr_";

const decodePathSegment = (segment: string): string => {
    try {
        return decodeURIComponent(segment);
    } catch {
        return segment;
    }
};

const boundSegment = (
    segment: string,
    maxLength: number,
    digestIdentity: string = segment,
    forceDigest: boolean = false
): string => {
    if (!forceDigest && segment.length <= maxLength) return segment;
    const digest = createHash("sha256").update(digestIdentity).digest("hex").slice(0, 12);
    if (maxLength <= digest.length) return digest.slice(0, Math.max(1, maxLength));
    return `${segment.slice(0, Math.max(1, maxLength - digest.length - 1))}-${digest}`;
};

const sanitizeBoundedSegment = (segment: string, maxLength: number, additionalIdentity: string = ""): string => {
    const decoded = decodePathSegment(segment);
    const sanitized = decoded.normalize("NFKC").replace(/[^a-zA-Z0-9._~-]/g, "_");
    const nonTraversing =
        sanitized.length === 0 || /^\.+$/.test(sanitized) ? sanitized.replace(/\./g, "_") || "_" : sanitized;
    const identityChanged = decoded !== nonTraversing || additionalIdentity.length > 0;
    const needsBounding = nonTraversing.length > maxLength;
    const reservedLiteral = nonTraversing.startsWith(ENCODED_SEGMENT_PREFIX);
    if (!identityChanged && !needsBounding && !reservedLiteral) return nonTraversing;

    const category = identityChanged ? "encoded" : needsBounding ? "bounded" : "literal";
    const tagged = `${ENCODED_SEGMENT_PREFIX}${category}_${nonTraversing}`;
    return boundSegment(tagged, maxLength, JSON.stringify([decoded, additionalIdentity]), true);
};

/** Maps an untrusted URL path segment to a portable, bounded filename segment. */
export const sanitizeOutputPathSegment = (segment: string, maxLength = MAX_DIRECTORY_SEGMENT_LENGTH): string =>
    sanitizeBoundedSegment(segment, maxLength);

/** Derives a portable asset filename without accepting partial extension matches. */
export const getSanitizedAssetFilename = (resourceUrl: string): string | undefined => {
    let pathname: string;
    let search = "";
    try {
        const parsed = new URL(resourceUrl);
        pathname = parsed.pathname;
        search = parsed.search;
    } catch {
        pathname = resourceUrl.split(/[?#]/, 1)[0];
        search = resourceUrl.includes("?") ? `?${resourceUrl.split("?").slice(1).join("?").split("#", 1)[0]}` : "";
    }

    const pathSegments = pathname.split("/");
    const rawFilename = decodePathSegment(pathSegments[pathSegments.length - 1] ?? "");
    const extensionMatch = rawFilename.match(ASSET_EXTENSION);
    if (!extensionMatch) return undefined;

    const extension = extensionMatch[0];
    const rawBase = rawFilename.slice(0, -extension.length);
    const identitySuffix = `${rawBase.length === 0 ? "\0synthetic-basename" : ""}${search}`;
    const base = sanitizeBoundedSegment(rawBase || "asset", MAX_FILENAME_LENGTH - extension.length, identitySuffix);
    return `${base}${extension}`;
};

/**
 * Returns the directory that owns a mirrored host. By default, always nests the
 * host under the output root. Pass `isBatchTargetRoot: true` only when the caller
 * knows `outputRoot` is itself a batch per-target root that may already end in its
 * target host — in that case a matching basename is treated as already-owned and
 * is not nested again.
 */
export const resolveHostOutputDirectory = (
    outputRoot: string,
    host: string,
    isBatchTargetRoot: boolean = false
): string => {
    const outputHost = toOutputHost(host);
    const candidate =
        isBatchTargetRoot && path.basename(path.resolve(outputRoot)) === outputHost
            ? outputRoot
            : path.join(outputRoot, outputHost);
    const relative = path.relative(path.resolve(outputRoot), path.resolve(candidate));
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`Refusing to resolve host outside output root: ${host}`);
    }
    return candidate;
};

/** Mirrors a URL pathname below its host-owned output directory. */
export const resolveAssetOutputDirectory = (
    outputRoot: string,
    resourceUrl: string,
    isBatchTargetRoot: boolean = false
): string => {
    const { rawHost, directory } = getURLDirectory(resourceUrl);
    const safeSegments = directory
        .split(/[\\/]+/)
        .filter((segment) => segment.length > 0)
        .map((segment) => sanitizeOutputPathSegment(segment));
    return path.join(resolveHostOutputDirectory(outputRoot, rawHost, isBatchTargetRoot), ...safeSegments);
};
