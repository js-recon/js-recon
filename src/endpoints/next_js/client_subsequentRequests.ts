import fs from "fs";
import path from "path";
import parser from "@babel/parser";
import _traverse from "@babel/traverse";
import makeRequest from "../../utility/makeReq.js";
import { printMsg, MSG } from "../../utility/printMsg.js";
const traverse = (_traverse.default ?? _traverse) as typeof _traverse.default;

let toReturn = [];

/**
 * Checks for client-side paths in a file and appends discovered paths to the module-scoped `toReturn` array.
 *
 * @param {string[]} files - The list of files to check
 * @param {string} url - The base URL to resolve relative URLs against
 * @returns {Promise<void>} - A promise that resolves when all files have been processed
 */
const checkHref = async (files, url) => {
    // open each file and read the contents
    for (const file of files) {
        const content = fs.readFileSync(file, "utf-8");

        // go through each line
        const lines = content.split("\n");
        for (const line of lines) {
            // check what is the type of line's content by matching it against regex
            if (line.match(/^[0-9a-z]+:I\[.+/)) {
                // console.log("JS Chunks");
                continue;
                // } else if (line.match(/^[0-9a-z\s\.]+:([A-Za-z0-9\,\.\s\-]+:)?[\[\{].+/)) {
            } else if (line.match(/^[0-9a-z]+:\[.+/)) {
                // extract the JS code. i.e. between [ and ]
                let jsCode;
                try {
                    jsCode = `[${line.match(/\[(.+)\]/)[1]}]`;
                } catch (err) {
                    continue;
                }

                // parse JS code with ast
                let ast;
                try {
                    ast = parser.parse(jsCode, {
                        sourceType: "unambiguous",
                        plugins: ["jsx", "typescript"],
                        errorRecovery: true,
                    });
                } catch (err) {
                    continue;
                }

                // traverse the ast, and find the objects with href, and external
                let finds: any[] = [];
                traverse(ast, {
                    ObjectExpression(path) {
                        const properties = path.node.properties;
                        let hasHrefOrUrl = false;
                        let hasExternal = false;
                        let hasChildren = false;
                        let hrefValue = null;
                        let externalValue = null;

                        for (const prop of properties) {
                            if (prop.type === "SpreadElement") continue;
                            const prop_name = jsCode.substring(prop.key.start, prop.key.end);
                            if (prop_name === '"href"') {
                                hasHrefOrUrl = true;
                                if (prop.type === "ObjectProperty") {
                                    hrefValue = jsCode
                                        .substring(prop.value.start, prop.value.end)
                                        .replace(/^"|"$/g, "");
                                }
                            }
                            if (prop_name === '"external"') {
                                hasExternal = true;
                                if (prop.type === "ObjectProperty") {
                                    externalValue = jsCode
                                        .substring(prop.value.start, prop.value.end)
                                        .replace(/^"|"$/g, "");
                                }
                            }
                            if (prop_name === '"children"') {
                                hasChildren = true;
                            }
                        }

                        if (hasHrefOrUrl) {
                            if ((hasExternal || hasChildren) && !hrefValue.startsWith("#")) {
                                // if the path doesn't starts with a `/`, then resolve the path
                                if (!hrefValue.startsWith("/") && !hrefValue.startsWith("http")) {
                                    let path = file
                                        .replace(/output\/[a-zA-Z0-9_\.\-]+\/___subsequent_requests\//, "/")
                                        .split("/");
                                    // remove the last one
                                    path.pop();
                                    path = path.join("/");
                                    const fileUrl = url + path;

                                    // now, resolve the path
                                    const resolvedPath = new URL(hrefValue, fileUrl).href;
                                    finds.push({
                                        href: resolvedPath,
                                        external: externalValue,
                                    });
                                } else {
                                    finds.push({
                                        href: hrefValue,
                                        external: externalValue,
                                    });
                                }
                            }
                        }
                    },
                });

                // // iterate through the finds and resolve the paths
                // for (const find of finds) {
                //   console.log(find);
                //   report += `### ${find.href}\n`;
                //   report += `${find.external}\n`;
                // }

                for (const find of finds) {
                    toReturn.push(find.href);
                }
            } else {
                // console.log("Unknown");
                // console.log(line);
                continue;
            }
        }
    }
};

const checkSlug = async (files, url) => {
    // open each file and read the contents
    for (const file of files) {
        const content = fs.readFileSync(file, "utf-8");

        // go through each line
        const lines = content.split("\n");
        for (const line of lines) {
            if (line.match(/^[0-9a-z]+:I\[.+/)) {
                continue;
            } else if (line.match(/^[0-9a-z]+:\[.+/)) {
                let jsCode;
                try {
                    jsCode = `[${line.match(/\[(.+)\]/)[1]}]`;
                } catch (err) {
                    continue;
                }

                let jsonObject;
                try {
                    jsonObject = JSON.parse(jsCode);
                } catch (error) {
                    continue;
                }

                const slugUrls = [];
                const traverse = (obj) => {
                    if (obj && typeof obj === "object") {
                        if (obj.slug) {
                            const slugUrl = new URL(
                                obj.slug,
                                file.replace(/output\/[a-zA-Z0-9_\.\-]+\/___subsequent_requests\//, url + "/")
                            ).href;
                            slugUrls.push(slugUrl);
                        }

                        Object.values(obj).forEach((value) => traverse(value));
                    }
                };

                traverse(jsonObject);

                for (const path of slugUrls) {
                    const res = await makeRequest(path, {});
                    const statusCode = res.status;
                    if (statusCode !== 404) {
                        toReturn.push(path);
                    }
                }
            } else {
                continue;
            }
        }
    }
};

const client_subsequentRequests = async (subsequentRequestsDir, url) => {
    //   let report = `## Subsequent Requests\n`;
    printMsg(MSG.Header, "[i] Using subsequent requests file method");

    // get all the files in the directory
    const walkSync = (dir, files = []) => {
        fs.readdirSync(dir).forEach((file) => {
            let dirFile = path.join(dir, file);
            if (fs.statSync(dirFile).isDirectory()) {
                walkSync(dirFile, files);
            } else {
                files.push(dirFile);
            }
        });
        return files;
    };
    const files = walkSync(subsequentRequestsDir);

    await checkHref(files, url);
    // await checkSlug(files, url);

    return toReturn;
};

export default client_subsequentRequests;
