import { printMsg, MSG } from "./printMsg.js";

/**
 * Resolves a relative path with a given base URL.
 *
 * The behavior of the URL constructor is used to handle various cases of path resolution.
 * If the base URL does not end with a '/', its last path segment is typically treated as a "file",
 * and relative paths are resolved from the "directory" containing that "file".
 * Examples:
 * - url='https://site.com/something', path='./main.js' => 'https://site.com/main.js'
 *   (Base for resolution becomes 'https://site.com/')
 * - url='https://site.com/something/', path='./main.js' => 'https://site.com/something/main.js'
 *   (Base for resolution is 'https://site.com/something/')
 * - url='https://site.com/something/other', path='../main.js' => 'https://site.com/main.js'
 *   (Base for resolution becomes 'https://site.com/something/', then '../' navigates up)
 *
 * @param {string} url - The base URL for resolving the relative path
 * @param {string} path - The relative path to be resolved
 * @returns {string} The resolved absolute URL
 * @throws {Error} If an error occurs while resolving the path
 */
const resolvePath = (url: string, path: string) => {
    try {
        // The URL constructor handles various cases of path resolution.
        // If 'url' (the base URL) does not end with a '/', its last path segment
        // is typically treated as a "file", and relative paths are resolved
        // from the "directory" containing that "file".
        // This behavior aligns with the provided examples:
        // - url='https://site.com/something', path='./main.js' => 'https://site.com/main.js'
        //   (Base for resolution becomes 'https://site.com/')
        // - url='https://site.com/something/', path='./main.js' => 'https://site.com/something/main.js'
        //   (Base for resolution is 'https://site.com/something/')
        // - url='https://site.com/something/other', path='../main.js' => 'https://site.com/main.js'
        //   (Base for resolution becomes 'https://site.com/something/', then '../' navigates up)
        const resolvedUrl = new URL(path, url);
        return resolvedUrl.href;
    } catch (e) {
        printMsg(MSG.Err, `Error resolving path "${path}" with base URL "${url}": ${e.message}`);
        // Rethrowing the error to signal failure to the caller.
        // Alternative error handling (e.g., returning null) can be implemented if required.
        throw e;
    }
};

export default resolvePath;
