import resolvePath from "../../../utility/resolvePath.js";

/**
 * Iterate over a list of URLs and store them in a nested object structure.
 *
 * For each URL, the function will:
 *  - Ignore URLs that start with "mailto:" or "tel:"
 *  - Resolve relative URLs against the given base URL
 *  - Parse the URL and extract the origin and pathname
 *  - Create a nested object structure with the origin as the top-level key
 *  - Create a nested object structure with the pathname as the key
 *  - Ensure that every origin has a root path ("/") inserted
 *
 * The resulting object structure will have the following shape:
 *  - { origin: { /path/to/resource: {}, ... } }
 *
 * @param {string} baseUrl - The base URL to resolve relative URLs against
 * @param {string[]} urls - The list of URLs to iterate over
 * @returns {Promise<object>} - A promise that resolves to the nested object structure
 */
const iterate_n_store = async (baseUrl: string, urls: string[]) => {
    const result = {};
    for (let url of urls) {
        if (url.startsWith("mailto:") || url.startsWith("tel:")) {
            continue;
        }

        if (url.startsWith("/")) {
            url = resolvePath(baseUrl, url);
        }

        // Parse the URL once and extract the bits we need
        const { origin, pathname } = new URL(url);

        // Ensure we have a container object for this origin
        if (!result[origin]) {
            result[origin] = {};
        }

        // Always insert the root path for this origin
        if (!result[origin]["/"]) {
            result[origin]["/"] = {};
        }

        // Normalise the pathname – strip leading/trailing slashes and split into segments
        const segments = pathname === "/" ? [] : pathname.replace(/^\/|\/$/g, "").split("/");

        let cumulativePath = ""; // will build up like "/app", "/app/dashboard"
        let currentNode = result[origin];

        for (const segment of segments) {
            cumulativePath += `/${segment}`;
            if (!currentNode[cumulativePath]) {
                currentNode[cumulativePath] = {};
            }
            // descend into the newly created / already existing child
            currentNode = currentNode[cumulativePath];
        }
    }

    return result;
};

export default iterate_n_store;
