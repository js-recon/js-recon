export interface OxylabsConfig {
    username: string;
    password: string;
    country?: string;
    city?: string;
    sessionId?: string;
}

/**
 * Composes the Oxylabs datacenter-proxy username: auth is entirely encoded here, no separate API.
 * user-USERNAME[-country-XX]
 *
 * Verified against a live Oxylabs datacenter account (dc.oxylabs.io:8000) — the previous
 * `customer-USERNAME-cc-XX` residential-style scheme returns a 407 Proxy Authentication Required
 * against real datacenter credentials; this is the confirmed-working format per
 * https://developers.oxylabs.io/products/proxies/datacenter-proxies/select-country.
 *
 * `city` and `sessionId` are not supported here: Oxylabs' datacenter tier has no documented
 * username-level city targeting, and sticky sessions are selected by port number, not by a
 * username suffix — silently encoding either into the username would produce a wrong username
 * that fails auth, so both are rejected explicitly instead.
 */
export const composeOxylabsUsername = (cfg: OxylabsConfig): string => {
    if (cfg.city) {
        throw new Error(
            "Oxylabs config: `city` is not supported (no documented username-level city targeting for datacenter proxies). Omit `city`."
        );
    }
    if (cfg.sessionId) {
        throw new Error(
            "Oxylabs config: `sessionId` is not supported via username for datacenter proxies (sticky sessions are selected by port, not username). Omit `sessionId`."
        );
    }

    let username = `user-${cfg.username}`;
    if (cfg.country) {
        username += `-country-${cfg.country}`;
    }
    return username;
};

const OXYLABS_ENTRY_ENDPOINT = "dc.oxylabs.io:8000";

/** Composes the full Oxylabs datacenter proxy URL. */
export const buildOxylabsProxyUrl = (cfg: OxylabsConfig): string => {
    const username = composeOxylabsUsername(cfg);
    return `http://${encodeURIComponent(username)}:${encodeURIComponent(cfg.password)}@${OXYLABS_ENTRY_ENDPOINT}`;
};
