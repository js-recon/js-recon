import type { AwsGatewayEntry } from "./awsConfig.js";
import type { OxylabsConfig } from "./oxylabsProxy.js";

/**
 * Config-merging library evaluation (per issue requirement to record this decision):
 * evaluated convict/nconf/rc/cosmiconfig — none justified. This codebase hand-threads every
 * other flag/global (see configureSandbox.ts, globals.ts); the merge surface here is small
 * (4 fields x 4 methods x 3-level precedence), fully pure/testable as hand-written `??`
 * fallbacks. Decision: hand-roll, no new dependency.
 */

export type ProxyMethod = "aws" | "socks" | "http" | "oxylabs";

export interface ResolvedProxyConfig {
    method: ProxyMethod | null;
    url?: string;
    oxylabs?: OxylabsConfig;
    awsGatewayMap?: Record<string, AwsGatewayEntry>;
}

export interface ResolveProxyConfigCliInput {
    proxyMethod?: string;
    proxyUrl?: string;
    oxylabsUsername?: string;
    oxylabsPassword?: string;
    oxylabsCountry?: string;
    oxylabsCity?: string;
    oxylabsSessionId?: string;
    oxylabsEndpoint?: string;
}

export interface ResolveProxyConfigInput {
    cli: ResolveProxyConfigCliInput;
    env: NodeJS.ProcessEnv;
    ignoreEnv: boolean;
    /** Already-parsed contents of .proxy_config.json (or {} if the file doesn't exist / has no proxy config). */
    configFileParsed: {
        method?: string;
        socks?: { url?: string };
        http?: { url?: string };
        oxylabs?: Partial<OxylabsConfig>;
        aws?: Record<string, AwsGatewayEntry>;
    };
}

const ENDPOINT_SOURCE_ERROR =
    "Oxylabs config: `endpoint` comes from a lower-precedence source than the password and would receive it. Set the endpoint where the password is set (--oxylabs-endpoint, JS_RECON_OXYLABS_ENDPOINT or the proxy config file).";

/** Commander option value sources, highest precedence first: command line, environment, application YAML config. */
const OPTION_SOURCE_PRECEDENCE = new Map([
    ["cli", 0],
    ["env", 1],
    ["config", 2],
]);

/**
 * Applies the endpoint rule to the `proxy` command's own options. Their values merge the command line, the
 * environment and the application YAML config, which resolveProxyConfig sees as one CLI layer, so the caller
 * passes Command#getOptionValueSource() for each option that has a value (undefined otherwise).
 */
export const assertOxylabsEndpointSource = (endpointSource?: string, passwordSource?: string): void => {
    const endpointRank = OPTION_SOURCE_PRECEDENCE.get(endpointSource);
    const passwordRank = OPTION_SOURCE_PRECEDENCE.get(passwordSource);
    if (endpointRank !== undefined && passwordRank !== undefined && endpointRank > passwordRank) {
        throw new Error(ENDPOINT_SOURCE_ERROR);
    }
};

const isValidMethod = (value: unknown): value is ProxyMethod => {
    return value === "aws" || value === "socks" || value === "http" || value === "oxylabs";
};

export const resolveProxyConfig = (input: ResolveProxyConfigInput): ResolvedProxyConfig => {
    const { cli, env, ignoreEnv, configFileParsed } = input;

    const envMethod = ignoreEnv ? undefined : env.JS_RECON_PROXY_METHOD;
    const rawMethod = cli.proxyMethod || envMethod || configFileParsed.method;
    const method = isValidMethod(rawMethod) ? rawMethod : null;

    if (method === null) {
        return { method: null };
    }

    if (method === "socks" || method === "http") {
        const envUrl = ignoreEnv ? undefined : env.JS_RECON_PROXY_URL;
        const url = cli.proxyUrl || envUrl || configFileParsed[method]?.url;
        return { method, url };
    }

    if (method === "oxylabs") {
        const envUsername = ignoreEnv ? undefined : env.JS_RECON_OXYLABS_USERNAME;
        const envPassword = ignoreEnv ? undefined : env.JS_RECON_OXYLABS_PASSWORD;
        const envCountry = ignoreEnv ? undefined : env.JS_RECON_OXYLABS_COUNTRY;
        const envCity = ignoreEnv ? undefined : env.JS_RECON_OXYLABS_CITY;
        const envSessionId = ignoreEnv ? undefined : env.JS_RECON_OXYLABS_SESSION_ID;
        const envEndpoint = ignoreEnv ? undefined : env.JS_RECON_OXYLABS_ENDPOINT;
        const fileOxylabs = configFileParsed.oxylabs || {};

        const username = cli.oxylabsUsername || envUsername || fileOxylabs.username;
        const password = cli.oxylabsPassword || envPassword || fileOxylabs.password;
        const country = cli.oxylabsCountry || envCountry || fileOxylabs.country;
        const city = cli.oxylabsCity || envCity || fileOxylabs.city;
        const sessionId = cli.oxylabsSessionId || envSessionId || fileOxylabs.sessionId;
        const endpoint = cli.oxylabsEndpoint || envEndpoint || fileOxylabs.endpoint;

        if (!username || !password) {
            return { method: null };
        }

        // The endpoint receives the password, so it may only come from the password's own source or a
        // higher-precedence one: a proxy config file must not redirect command-line or environment credentials.
        const precedence = (cliValue: unknown, envValue: unknown): number => (cliValue ? 0 : envValue ? 1 : 2);
        if (endpoint && precedence(cli.oxylabsEndpoint, envEndpoint) > precedence(cli.oxylabsPassword, envPassword)) {
            throw new Error(ENDPOINT_SOURCE_ERROR);
        }

        return { method, oxylabs: { username, password, country, city, sessionId, endpoint } };
    }

    // method === "aws"
    return { method, awsGatewayMap: configFileParsed.aws || {} };
};
