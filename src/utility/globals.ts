// Proxy Configuration
/** Path to the proxy configuration file */
export let proxyConfigFile = ".proxy_config.json";
/** Whether to route requests through a proxy */
export let useProxy = false;
/** Selected proxy method */
export let proxyMethod: "aws" | "socks" | "http" | "oxylabs" | null = null;
/** Resolved SOCKS/HTTP proxy URL (method === "socks" | "http") */
export let proxyUrl: string | undefined;
/** Resolved Oxylabs datacenter proxy config (method === "oxylabs") */
export let oxylabsConfig:
    | { username: string; password: string; country?: string; city?: string; sessionId?: string }
    | undefined;
/** Whether to skip reading JS_RECON_* env vars during proxy config resolution */
export let ignoreProxyEnv = false;

/**
 * Sets the proxy configuration file path.
 * @param file - Path to the proxy configuration file
 */
export const setProxyConfigFile = (file: string): void => {
    proxyConfigFile = file;
};

/**
 * Enables or disables routing requests through a proxy.
 * @param value - Whether to use a proxy
 */
export const setUseProxy = (value: boolean): void => {
    useProxy = value;
};

/**
 * Sets the selected proxy method.
 * @param value - The resolved proxy method, or null if none configured
 */
export const setProxyMethod = (value: "aws" | "socks" | "http" | "oxylabs" | null): void => {
    proxyMethod = value;
};

/**
 * Sets the resolved SOCKS/HTTP proxy URL.
 * @param value - The proxy URL
 */
export const setProxyUrl = (value: string | undefined): void => {
    proxyUrl = value;
};

/**
 * Sets the resolved Oxylabs datacenter proxy config.
 * @param value - The Oxylabs config
 */
export const setOxylabsConfig = (
    value: { username: string; password: string; country?: string; city?: string; sessionId?: string } | undefined
): void => {
    oxylabsConfig = value;
};

/**
 * Sets whether JS_RECON_* env vars should be ignored during proxy config resolution.
 * @param value - Whether to ignore env vars
 */
export const setIgnoreProxyEnv = (value: boolean): void => {
    ignoreProxyEnv = value;
};

// Response Cache Configuration
/** Whether response caching is disabled */
export let disableCache = false;
/** Path to the response cache file */
export let respCacheFile = ".resp_cache.json";

/**
 * Disables or enables response caching.
 * @param value - Whether to disable caching
 */
export const setDisableCache = (value: boolean): void => {
    disableCache = value;
};

/**
 * Sets the response cache file path.
 * @param file - Path to the response cache file
 */
export const setRespCacheFile = (file: string): void => {
    respCacheFile = file;
};

/**
 * Gets the current cache disable status.
 * @returns Whether caching is disabled
 */
export const getDisableCache = (): boolean => {
    return disableCache;
};

/**
 * Gets the current response cache file path.
 * @returns Path to the response cache file
 */
export const getRespCacheFile = (): string => {
    return respCacheFile;
};

// Cache-only Configuration
/** When true, makeRequest never hits the network — only the cache is consulted */
export let cacheOnly = false;

export const setCacheOnly = (value: boolean): void => {
    cacheOnly = value;
};

export const getCacheOnly = (): boolean => {
    return cacheOnly;
};

// Sandbox Configuration
/** Whether to disable the browser sandbox */
export let disableSandbox = false;

/**
 * Sets the disable sandbox flag.
 * @param value - Whether to disable the sandbox
 */
export const setDisableSandbox = (value: boolean): void => {
    disableSandbox = value;
};

/**
 * Gets the current disable sandbox status.
 * @returns Whether the sandbox is disabled
 */
export const getDisableSandbox = (): boolean => {
    return disableSandbox;
};

// Auto-execution Configuration
/** Whether to auto-approve code execution */
export let yes = false;

/**
 * Sets the auto-approval flag for code execution.
 * @param value - Whether to auto-approve code execution
 */
export const setYes = (value: boolean): void => {
    yes = value;
};

/**
 * Gets the current auto-approval status.
 * @returns Whether auto-approval is enabled
 */
export const getYes = (): boolean => {
    return yes;
};

// Request Timeout Configuration
/** Request timeout in milliseconds */
export let requestTimeout = 30000;

/**
 * Sets the request timeout value.
 * @param value - Timeout in milliseconds
 */
export const setRequestTimeout = (value: number): void => {
    requestTimeout = value;
};

/**
 * Gets the current request timeout value.
 * @returns Timeout in milliseconds
 */
export const getRequestTimeout = (): number => {
    return requestTimeout;
};

// AI Configuration
/** Array of AI analysis options */
export let ai: string[] = [];
/** API key for the configured AI provider */
export let aiApiKey = "";
/** AI model to use for analysis */
export let aiModel = "gpt-4o-mini";
/** AI service provider (openai, ollama, anthropic, etc.) */
export let aiServiceProvider = "openai";
/** Number of AI analysis threads */
export let aiThreads = 5;
/** Custom AI endpoint URL */
export let aiEndpoint: string | undefined = undefined;

/**
 * Sets the AI analysis options.
 * @param value - Array of AI options (e.g., ['description'])
 */
export const setAi = (value: string[]): void => {
    ai = value;
};

/**
 * Sets the API key for the configured AI provider.
 * @param value - AI provider API key
 */
export const setAiApiKey = (value: string): void => {
    aiApiKey = value;
};

/**
 * Gets the current AI analysis options.
 * @returns Array of AI options
 */
export const getAi = (): string[] => {
    return ai;
};

/**
 * Gets the API key for the configured AI provider.
 * @returns AI provider API key
 */
export const getAiApiKey = (): string => {
    return aiApiKey;
};

/**
 * Gets the current AI model.
 * @returns AI model identifier
 */
export const getAiModel = (): string => {
    return aiModel;
};

/**
 * Sets the AI model to use.
 * @param value - AI model identifier
 */
export const setAiModel = (value: string): void => {
    aiModel = value;
};

/**
 * Sets the number of AI analysis threads.
 * @param value - Number of threads
 */
export const setAiThreads = (value: number): void => {
    aiThreads = value;
};

/**
 * Gets the number of AI analysis threads.
 * @returns Number of threads
 */
export const getAiThreads = (): number => {
    return aiThreads;
};

/**
 * Sets the AI service provider.
 * @param value - Service provider identifier
 */
export const setAiServiceProvider = (value: string): void => {
    aiServiceProvider = value;
};

/**
 * Gets the AI service provider.
 * @returns Service provider identifier
 */
export const getAiServiceProvider = (): string => {
    return aiServiceProvider;
};

/**
 * Sets a custom AI endpoint URL.
 * @param value - Custom endpoint URL
 */
export const setAiEndpoint = (value: string): void => {
    aiEndpoint = value;
};

/**
 * Gets the custom AI endpoint URL.
 * @returns Custom endpoint URL or undefined
 */
export const getAiEndpoint = (): string | undefined => {
    return aiEndpoint;
};

// Quiet mode — suppresses verbose detection logs (used by fingerprint)
export let quiet = false;

export const setQuiet = (value: boolean): void => {
    quiet = value;
};

export const getQuiet = (): boolean => {
    return quiet;
};

// Verbose mode — shows detailed file write error messages
export let verbose = false;

export const setVerbose = (value: boolean): void => {
    verbose = value;
};

export const getVerbose = (): boolean => {
    return verbose;
};

// Technology Detection
/** Detected technology stack */
export let tech = "";

/**
 * Sets the detected technology stack.
 * @param value - Technology identifier (e.g., 'next', 'nuxt', 'svelte')
 */
export const setTech = (value: string): void => {
    tech = value;
};

/**
 * Gets the currently detected technology stack.
 * @returns Technology identifier
 */
export const getTech = (): string => {
    return tech;
};

// OpenAPI Configuration
/** Whether to generate OpenAPI specifications */
export let openapi = false;
/** Output file path for OpenAPI specifications */
export let openapiOutputFile = "mapped-openapi.json";

/**
 * Enables or disables OpenAPI specification generation.
 * @param value - Whether to generate OpenAPI specs
 */
export const setOpenapi = (value: boolean): void => {
    openapi = value;
};

/**
 * Gets the OpenAPI generation status.
 * @returns Whether OpenAPI generation is enabled
 */
export const getOpenapi = (): boolean => {
    return openapi;
};

/**
 * Sets the OpenAPI output file path.
 * @param value - Path to the OpenAPI output file
 */
export const setOpenapiOutputFile = (value: string): void => {
    openapiOutputFile = value;
};

/**
 * Gets the OpenAPI output file path.
 * @returns Path to the OpenAPI output file
 */
export const getOpenapiOutputFile = (): string => {
    return openapiOutputFile;
};

// openapi output
export interface OpenapiOutputItem {
    url: string;
    method: string;
    path: string;
    headers: {
        [key: string]: string;
    };
    body: string;
    chunkId: string;
    functionFile: string;
    functionFileLine: number;
    crossChunkParams?: Array<{ chunkId: string; params: string; file: string; line: number }>;
    summary?: string;
    serverActionCallChunkId?: string;
    serverActionCallFile?: string;
    serverActionCallLine?: number;
    /**
     * Optional override for collection grouping. When set, the OpenAPI generator
     * uses this as the operation's tag and the Postman generator places the
     * item under a flat top-level folder with this name (bypassing path-segment
     * folder derivation).
     */
    collectionFolder?: string;
}
/** Array of OpenAPI output items */
export let openapiOutput: OpenapiOutputItem[] = [];

/**
 * Adds an item to the OpenAPI output collection.
 * @param value - OpenAPI output item to add
 */
export const addOpenapiOutput = (value: OpenapiOutputItem): void => {
    openapiOutput.push(value);
};

/**
 * Gets the current OpenAPI output collection.
 * @returns Array of OpenAPI output items
 */
export const getOpenapiOutput = (): OpenapiOutputItem[] => {
    return openapiOutput;
};

/**
 * Clears the OpenAPI output collection. Must be called between targets in
 * batch mode, otherwise later targets accumulate earlier targets' entries.
 */
export const clearOpenapiOutput = (): void => {
    openapiOutput = [];
};

// OpenAPI Chunk Tag Configuration
/** Whether to add chunk ID tags to OpenAPI specifications */
export let openapiChunkTag = false;

/**
 * Enables or disables chunk ID tags in OpenAPI specs.
 * @param value - Whether to add chunk ID tags
 */
export const setOpenapiChunkTag = (value: boolean): void => {
    openapiChunkTag = value;
};

/**
 * Max recursion depth for HTTP-client URL fan-out and cross-file resolution.
 * Set via --max-recursion-depth on `map`. Higher values produce more endpoint
 * variations at the cost of runtime.
 */
let maxRecursionDepth = 3;

export const setMaxRecursionDepth = (value: number): void => {
    maxRecursionDepth = value;
};

export const getMaxRecursionDepth = (): number => {
    return maxRecursionDepth;
};

/**
 * Gets the chunk tag configuration status.
 * @returns Whether chunk ID tags are enabled
 */
export const getOpenapiChunkTag = (): boolean => {
    return openapiChunkTag;
};

// GraphQL Extraction Configuration
/** Whether to scan JS for embedded GraphQL operations during `map` */
export let graphqlEnabled = true;

export const setGraphqlEnabled = (value: boolean): void => {
    graphqlEnabled = value;
};

export const getGraphqlEnabled = (): boolean => {
    return graphqlEnabled;
};
