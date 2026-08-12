export interface CustomHeaderPair {
    name: string;
    value: string;
}

/**
 * Folds an array of custom header name/value pairs into a plain Record, suitable for merging
 * into a `HeadersInit`/`Record<string,string>`. Later entries win when names repeat.
 * @param pairs - Array of name/value header pairs
 * @returns Record mapping header name to header value
 */
export const customHeadersToRecord = (pairs: readonly CustomHeaderPair[]): Record<string, string> => {
    const record: Record<string, string> = {};
    for (const { name, value } of pairs) {
        record[name] = value;
    }
    return record;
};

/**
 * Parses a single `-H/--header` CLI flag value into a name/value pair. Expects the
 * `"Name: Value"` shape (colon-separated, whitespace around each side trimmed).
 * @param raw - Raw flag value as passed on the command line
 * @returns The parsed pair, or `null` if `raw` has no colon separator
 */
export const parseHeaderFlagValue = (raw: string): CustomHeaderPair | null => {
    const idx = raw.indexOf(":");
    if (idx === -1) return null;
    const name = raw.slice(0, idx).trim();
    const value = raw.slice(idx + 1).trim();
    if (!name) return null;
    return { name, value };
};
