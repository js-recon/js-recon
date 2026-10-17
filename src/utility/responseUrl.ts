/**
 * makeRequest rebuilds every Response it returns (from a buffered body, the response cache or a
 * headless-browser fallback), and a constructed Response has an empty `url`. These helpers put the
 * URL the content actually came from, after redirects, back on the Response, so page parsers can
 * resolve a page's relative script and link paths the way a browser does.
 */

/** Sets `response.url` to `finalUrl` when it is known, and returns the same Response. */
export const withResponseUrl = (response: Response, finalUrl: string | null | undefined): Response => {
    if (finalUrl) {
        Object.defineProperty(response, "url", { value: finalUrl, enumerable: true, configurable: true });
    }
    return response;
};

/**
 * The URL to resolve a fetched page's relative references against: where the page was served from
 * after redirects, or the requested URL when that is unknown.
 */
export const responseBaseUrl = (response: Response | null | undefined, requestedUrl: string): string =>
    response?.url || requestedUrl;
