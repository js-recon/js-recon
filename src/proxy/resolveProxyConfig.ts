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
        const fileOxylabs = configFileParsed.oxylabs || {};

        const username = cli.oxylabsUsername || envUsername || fileOxylabs.username;
        const password = cli.oxylabsPassword || envPassword || fileOxylabs.password;
        const country = cli.oxylabsCountry || envCountry || fileOxylabs.country;
        const city = cli.oxylabsCity || envCity || fileOxylabs.city;
        const sessionId = cli.oxylabsSessionId || envSessionId || fileOxylabs.sessionId;

        if (!username || !password) {
            return { method: null };
        }

        return { method, oxylabs: { username, password, country, city, sessionId } };
    }

    // method === "aws"
    return { method, awsGatewayMap: configFileParsed.aws || {} };
};
