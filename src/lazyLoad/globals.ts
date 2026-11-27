/** Global scope configuration for lazy loading */
let scope: string[] = [];
/** Global array of JavaScript URLs discovered during lazy loading */
let js_urls: string[] = [];
/** Global array of JSON URLs discovered during lazy loading */
let json_urls: string[] = [];
/** Maximum number of concurrent requests allowed */
let max_req_queue: number;
/** List of URLs which has been crawled */
let crawled_urls: string[] = [];
/** Global map of JS file content hash -> count of files seen with that hash (used by generic-tech stagnation detection) */
let js_file_hash_counts: Map<string, number> = new Map();
/** Total number of JS files whose content hash has been recorded */
let js_file_total_count = 0;

/**
 * Gets the current scope configuration.
 * @returns Array of domains in scope
 */
export const getScope = (): string[] => scope;

/**
 * Sets the scope configuration for lazy loading.
 * @param newScope - Array of domains to include in scope
 */
export const setScope = (newScope: string[]): void => {
    scope = newScope;
};

/**
 * Adds a domain to the current scope.
 * @param item - Domain to add to scope
 */
export const pushToScope = (item: string): void => {
    scope.push(item);
};

/**
 * Gets the current array of JavaScript URLs.
 * @returns Array of JavaScript URLs
 */
export const getJsUrls = (): string[] => js_urls;

/**
 * Clears all JavaScript URLs from the global array.
 */
export const clearJsUrls = (): void => {
    js_urls = [];
};

/**
 * Adds a JavaScript URL to the global array.
 * @param url - JavaScript URL to add
 */
export const pushToJsUrls = (url: string | string[]): number => {
    const beforeCount = js_urls.length;
    const urlsToAdd = Array.isArray(url) ? url : [url];
    js_urls.push(...urlsToAdd);

    // Remove duplicates
    js_urls = [...new Set(js_urls)];
    return js_urls.length - beforeCount;
};

/**
 * Gets the current array of JSON URLs.
 * @returns Array of JSON URLs
 */
export const getJsonUrls = (): string[] => json_urls;

/**
 * Clears all JSON URLs from the global array.
 */
export const clearJsonUrls = (): void => {
    json_urls = [];
};

/**
 * Adds a JSON URL to the global array.
 * @param url - JSON URL to add
 */
export const pushToJsonUrls = (url: string): void => {
    json_urls.push(url);
};

/**
 * Gets the maximum request queue size.
 * @returns Maximum number of concurrent requests
 */
export const getMaxReqQueue = (): number => max_req_queue;

/**
 * Sets the maximum request queue size.
 * @param newMax - Maximum number of concurrent requests to allow
 */
export const setMaxReqQueue = (newMax: number): void => {
    max_req_queue = newMax;
};

/**
 * Checks if a URL is already in the crawled URLs list.
 * @param url - URL to check
 * @returns True if URL is already crawled, false otherwise
 */
export const presentInCrawledUrls = (url: string): boolean => {
    return crawled_urls.includes(url);
};

/**
 * Adds a URL to the crawled URLs list if it's not already present.
 * @param url - URL to add to crawled list
 */
export const addCrawledUrl = (url: string | string[]): void => {
    if (Array.isArray(url)) {
        crawled_urls.push(...url);
    } else {
        if (!presentInCrawledUrls(url)) {
            crawled_urls.push(url);
        }
    }
};

/** Clears the per-target crawl history before processing another target. */
export const clearCrawledUrls = (): void => {
    crawled_urls = [];
};

/**
 * Records a JS file's content hash, incrementing both its per-hash count and the total count.
 * Used by generic-tech stagnation detection to track how much discovered content is duplicate.
 * @param hash - Content hash (e.g. sha256) of a discovered JS file
 */
export const recordJsFileHash = (hash: string): void => {
    js_file_hash_counts.set(hash, (js_file_hash_counts.get(hash) ?? 0) + 1);
    js_file_total_count++;
};

/**
 * Gets the current map of JS file content hash -> count.
 * @returns Map of content hash to occurrence count
 */
export const getJsFileHashCounts = (): Map<string, number> => js_file_hash_counts;

/**
 * Gets the total number of JS files whose content hash has been recorded.
 * @returns Total recorded JS file count
 */
export const getJsFileTotalCount = (): number => js_file_total_count;

/**
 * Clears all recorded JS file content hashes and resets the total count.
 */
export const clearJsFileHashCounts = (): void => {
    js_file_hash_counts = new Map();
    js_file_total_count = 0;
};
