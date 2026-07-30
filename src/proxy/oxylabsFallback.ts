import type { LoadedApplicationConfig } from "../config/applicationConfig.js";
import type { OxylabsConfig } from "./oxylabsProxy.js";

export interface DisabledOxylabsFallback {
    readonly enabled: false;
}

export interface EnabledOxylabsFallback {
    readonly enabled: true;
    readonly proxy: Readonly<OxylabsConfig>;
    readonly maxRequestsPerOrigin: number;
    readonly maxTotalRequests?: number;
    readonly maxOrigins?: number;
}

export type OxylabsFallbackConfiguration = DisabledOxylabsFallback | EnabledOxylabsFallback;

export interface ResolveOxylabsFallbackInput {
    readonly enabled: boolean;
    readonly maxRequestsPerOrigin: string | number;
    readonly maxTotalRequests?: string | number;
    readonly maxOrigins?: string | number;
    readonly loadedConfig: LoadedApplicationConfig | undefined;
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly ignoreEnvironment: boolean;
}

export class OxylabsFallbackConfigurationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "OxylabsFallbackConfigurationError";
    }
}

let fallbackConfiguration: OxylabsFallbackConfiguration = Object.freeze({ enabled: false });
let requestsByOrigin: ReadonlyMap<string, number> = new Map();
let totalRequests = 0;
let fallbackOrigins: ReadonlySet<string> = new Set();

const nonEmpty = (value: string | null | undefined): string | undefined => {
    const normalized = value?.trim();
    return normalized ? normalized : undefined;
};

const nonEmptySecret = (value: string | null | undefined): string | undefined =>
    value && value.trim().length > 0 ? value : undefined;

export const resolveOxylabsFallback = (input: ResolveOxylabsFallbackInput): OxylabsFallbackConfiguration => {
    if (!input.enabled) return Object.freeze({ enabled: false });
    if (!input.loadedConfig?.explicitlySupplied) {
        throw new OxylabsFallbackConfigurationError(
            "Oxylabs WAF fallback requires a config selected with explicit --config or JS_RECON_CONFIG"
        );
    }

    const yamlProxy = input.loadedConfig.data.oxylabs;
    const yamlUsername = nonEmpty(yamlProxy.username);
    const yamlPassword = nonEmptySecret(yamlProxy.password);
    if (!yamlUsername || !yamlPassword) {
        throw new OxylabsFallbackConfigurationError(
            "Oxylabs WAF fallback requires non-empty oxylabs.username and oxylabs.password in the selected YAML config"
        );
    }
    if (yamlProxy.city || yamlProxy.sessionId) {
        throw new OxylabsFallbackConfigurationError(
            "Oxylabs datacenter fallback does not support city or sessionId targeting; remove those values"
        );
    }

    const perOriginBudget = Number(input.maxRequestsPerOrigin);
    const totalBudget = Number(input.maxTotalRequests ?? 100);
    const originBudget = Number(input.maxOrigins ?? 25);
    if (!Number.isSafeInteger(perOriginBudget) || perOriginBudget < 1 || perOriginBudget > 10_000) {
        throw new OxylabsFallbackConfigurationError(
            "Oxylabs fallback max requests per origin must be a positive integer no greater than 10000"
        );
    }
    if (!Number.isSafeInteger(totalBudget) || totalBudget < 1 || totalBudget > 100_000) {
        throw new OxylabsFallbackConfigurationError(
            "Oxylabs fallback max total requests must be a positive integer no greater than 100000"
        );
    }
    if (!Number.isSafeInteger(originBudget) || originBudget < 1 || originBudget > 10_000) {
        throw new OxylabsFallbackConfigurationError(
            "Oxylabs fallback max origins must be a positive integer no greater than 10000"
        );
    }

    const readEnvironment = (key: string, secret = false): string | undefined => {
        if (input.ignoreEnvironment || input.env[key] === undefined) return undefined;
        const value = secret ? nonEmptySecret(input.env[key]) : nonEmpty(input.env[key]);
        if (!value) {
            throw new OxylabsFallbackConfigurationError(`${key} cannot be empty when it is set`);
        }
        return value;
    };
    const country = readEnvironment("JS_RECON_OXYLABS_COUNTRY") ?? nonEmpty(yamlProxy.country);
    if (country && !/^[a-z]{2}$/i.test(country)) {
        throw new OxylabsFallbackConfigurationError("Oxylabs country must be a two-letter country code");
    }
    const proxy: OxylabsConfig = Object.freeze({
        username: readEnvironment("JS_RECON_OXYLABS_USERNAME") ?? yamlUsername,
        password: readEnvironment("JS_RECON_OXYLABS_PASSWORD", true) ?? yamlPassword,
        ...(country ? { country: country.toLowerCase() } : {}),
    });

    return Object.freeze({
        enabled: true,
        proxy,
        maxRequestsPerOrigin: perOriginBudget,
        maxTotalRequests: totalBudget,
        maxOrigins: originBudget,
    });
};

export const configureOxylabsFallback = (configuration: OxylabsFallbackConfiguration): void => {
    fallbackConfiguration = configuration.enabled
        ? Object.freeze({
              enabled: true,
              proxy: Object.freeze({ ...configuration.proxy }),
              maxRequestsPerOrigin: configuration.maxRequestsPerOrigin,
              maxTotalRequests: configuration.maxTotalRequests ?? 100,
              maxOrigins: configuration.maxOrigins ?? 25,
          })
        : Object.freeze({ enabled: false });
    requestsByOrigin = new Map();
    totalRequests = 0;
    fallbackOrigins = new Set();
};

export const resetOxylabsFallback = (): void => configureOxylabsFallback({ enabled: false });

export const getOxylabsFallbackConfiguration = (): OxylabsFallbackConfiguration => fallbackConfiguration;

/**
 * Atomically reserves one paid fallback request for the URL's origin.
 * Returns a copied proxy config when the request is allowed, otherwise null.
 */
export const claimOxylabsFallback = (url: string): OxylabsConfig | null => {
    if (!fallbackConfiguration.enabled) return null;
    let origin: string;
    try {
        origin = new URL(url).origin;
    } catch {
        return null;
    }

    const used = requestsByOrigin.get(origin) ?? 0;
    if (used >= fallbackConfiguration.maxRequestsPerOrigin) return null;
    if (totalRequests >= (fallbackConfiguration.maxTotalRequests ?? 100)) return null;
    if (!fallbackOrigins.has(origin) && fallbackOrigins.size >= (fallbackConfiguration.maxOrigins ?? 25)) return null;
    requestsByOrigin = new Map(requestsByOrigin).set(origin, used + 1);
    fallbackOrigins = new Set(fallbackOrigins).add(origin);
    totalRequests += 1;
    return { ...fallbackConfiguration.proxy };
};
