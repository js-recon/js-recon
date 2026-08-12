import { discoverSourcemapUrls } from "../sourcemap.js";

/**
 * React sourcemap discovery. Thin named wrapper over the shared `discoverSourcemapUrls`
 * helper — kept as its own file/export so `--include-methods`/`--exclude-methods`/
 * `--list-methods` continue to see a `react_sourcemapUrls` method name.
 */
const react_sourcemapUrls = async (jsFiles: string[], threads: number = 1, output: string = ""): Promise<string[]> =>
    discoverSourcemapUrls(jsFiles, threads, output);

export default react_sourcemapUrls;
