/**
 * Given a URL, returns an object with the host and directory
 * of the URL. The directory is the path of the URL after the
 * host, and the filename is removed if it ends with a file extension.
 * For example, given "https://vercel.com/static/js/main.js", it will return
 * an object with host "vercel.com" and directory "/static/js".
 * @param {string} url - The URL to parse.
 * @returns {Object} An object with the host and directory of the URL.
 */
const getURLDirectory = (url: string) => {
    const u = new URL(url);
    const pathname = u.pathname;

    // Remove filename (last part after final /) if it ends with .js or any file extension
    const dir = pathname.replace(/\/[^\/?#]+\.[^\/?#]+$/, "");

    return {
        host: u.host.replace(":", "_"), // e.g., "vercel.com" or "localhost_3000"
        directory: dir, // e.g., "/static/js"
    };
};

/**
 * Given a URL, returns the filename by finding the first path segment
 * that ends with a recognized JS/JSON/Vue extension. This handles URLs
 * where a cachebuster or token segment follows the actual filename
 * (e.g. ".../beacon.min.js/v12345"), where checking only the final
 * path segment would fail to find the extension.
 * @param {string} url - The URL to parse.
 * @returns {string | undefined} The matched filename, or undefined if no segment matches.
 */
const getFilenameFromUrl = (url: string): string | undefined => {
    for (const chunk of url.split("/")) {
        const match = chunk.match(/[a-zA-Z0-9.\-_]+\.(mjs(\.map)?|js(on)?(\.map)?|vue)/);
        if (match) return match[0];
    }
    return undefined;
};

export { getURLDirectory, getFilenameFromUrl };
