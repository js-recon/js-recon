import { OpenapiOutputItem } from "./globals.js";
import { Chunks } from "./interfaces.js";
import * as globalsUtil from "./globals.js";
import replacePlaceholders from "./replaceUrlPlaceholders.js";
import { printMsg, MSG } from "./printMsg.js";

export interface Parameter {
    name: string;
    in: "query" | "header" | "path" | "cookie";
    description?: string;
    required?: boolean;
    schema: {
        type: string;
        example?: any;
        nullable?: boolean;
    };
}

export interface RequestBody {
    content: {
        [mediaType: string]: {
            schema: {
                type: string;
                properties?: {
                    [key: string]: {
                        type: string;
                        example: any;
                        nullable?: boolean;
                    };
                };
            };
            example?: any;
        };
    };
}

export interface Response {
    description: string;
}

export interface OperationObject {
    summary: string;
    description?: string;
    responses: {
        [statusCode: string]: Response;
    };
    parameters?: Parameter[];
    requestBody?: RequestBody;
    tags?: string[];
    [key: string]: any; // allows x- extension fields
}

export interface PathItemObject {
    [method: string]: OperationObject;
}

export interface OpenAPISpec {
    openapi: string;
    info: {
        title: string;
        description: string;
        version: string;
    };
    servers: Array<{
        url: string;
        description: string;
    }>;
    paths: {
        [path: string]: PathItemObject;
    };
}

/**
 * Returns the OpenAPI type string corresponding to the given value.
 *
 * If the value is null, returns "string" as OpenAPI 3.0 doesn't have a 'null' type.
 * If the value is an array, returns "array".
 * If the value is a primitive type (string, number, boolean), returns the corresponding OpenAPI type.
 * If the value is an object, returns "object".
 * For other types, returns "string" as a fallback.
 * @param value - The value to determine the OpenAPI type for
 * @returns The OpenAPI type string corresponding to the given value
 */
// Zod-style placeholder strings emitted by traceBody (e.g. "<number>", "<date>",
// "<array>") carry the field's real type even though they're stringified. Map
// them back to an OpenAPI type so the spec doesn't collapse every body field
// to `type: "string"`.
const ZOD_PLACEHOLDER_TYPE_MAP: { [k: string]: string } = {
    string: "string",
    number: "number",
    integer: "integer",
    bigint: "integer",
    boolean: "boolean",
    date: "string",
    array: "array",
    object: "object",
    enum: "string",
    literal: "string",
    unknown: "string",
    coerce: "string",
};

export const getZodPlaceholderType = (value: any): string | null => {
    if (typeof value !== "string") return null;
    const match = /^<([a-zA-Z]+)>$/.exec(value);
    if (!match) return null;
    return ZOD_PLACEHOLDER_TYPE_MAP[match[1]] ?? null;
};

export const getOpenApiType = (value: any): string => {
    if (value === null) {
        return "string"; // OpenAPI 3.0 doesn't have a 'null' type, use nullable
    }
    if (Array.isArray(value)) {
        return "array";
    }
    const placeholderType = getZodPlaceholderType(value);
    if (placeholderType) return placeholderType;
    const jsType = typeof value;
    if (["string", "number", "boolean", "object"].includes(jsType)) {
        return jsType;
    }
    return "string"; // Fallback for other types
};

/**
 * Generates an OpenAPI v3 spec based on the given OpenAPI output items.
 *
 * @param items - The OpenAPI output items to generate the spec from
 * @param chunks - The chunks of API endpoints that the items belong to
 * @returns The generated OpenAPI v3 spec
 */
export const generateOpenapiV3Spec = (items: OpenapiOutputItem[], _chunks: Chunks): OpenAPISpec => {
    const spec: OpenAPISpec = {
        openapi: "3.0.0",
        info: {
            title: "API Collection",
            description: "A collection of API endpoints discovered by js-recon.",
            version: "1.0.0",
        },
        servers: [
            {
                url: "{{baseUrl}}",
                description: "Base URL for the API",
            },
        ],
        paths: {},
    };

    // Tracks how many times we've already seen the same (path, method) so a
    // second callsite gets a disambiguating fragment on its path key rather than
    // being silently dropped. OpenAPI paths are opaque strings so a `#N` suffix
    // is preserved by tools that key on it.
    const callsiteCounts = new Map<string, number>();

    for (const item of items) {
        let rawItemPath = typeof item.path === "string" ? replacePlaceholders(item.path) : "";
        try {
            if (rawItemPath.startsWith("http://") || rawItemPath.startsWith("https://")) {
                rawItemPath = new URL(rawItemPath).pathname;
            }
        } catch {}
        const pathKeyBeforeQuery = rawItemPath.split("?")[0];
        const basePathKey = replacePlaceholders(
            pathKeyBeforeQuery.startsWith("/") ? pathKeyBeforeQuery : `/${pathKeyBeforeQuery}`
        );
        const VALID_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options", "trace"]);
        const rawMethod = typeof item.method === "string" ? item.method.toLowerCase() : "";
        const methodIsValid = VALID_METHODS.has(rawMethod);
        const method = methodIsValid ? rawMethod : "get";

        const dedupeKey = `${method} ${basePathKey}`;
        const seenBefore = callsiteCounts.get(dedupeKey) ?? 0;
        const pathKey = seenBefore === 0 ? basePathKey : `${basePathKey}#${seenBefore + 1}`;
        callsiteCounts.set(dedupeKey, seenBefore + 1);

        if (!spec.paths[pathKey]) {
            spec.paths[pathKey] = {};
        }

        // Avoid overwriting if the same path & method already processed (only
        // possible now when two identical items collide on the disambiguated
        // path — guard kept for safety).
        if (spec.paths[pathKey][method]) {
            continue;
        }

        const parameters: Parameter[] = Object.entries(item.headers || {}).map(([name, value]): Parameter => {
            const schema: Parameter["schema"] = {
                type: getOpenApiType(value),
                example: value,
            };
            if (value === null) {
                schema.nullable = true;
            }
            return {
                name,
                in: "header",
                required: true, // Assuming headers found are required for the call to succeed as intended
                schema,
            };
        });

        // Extract path parameters. The negative lookbehind/lookahead avoids
        // matching the inner braces of a `{{var}}` collection-level placeholder
        // (e.g. `{{graphqlEndpoint}}`) as a path parameter.
        const pathParams = pathKey.match(/(?<!\{)\{([^{}]+)\}(?!\})/g);
        if (pathParams) {
            for (const p of pathParams) {
                const paramName = p.slice(1, -1);
                parameters.push({
                    name: paramName,
                    in: "path",
                    required: true,
                    schema: { type: "string", example: "any" },
                });
            }
        }

        // Extract query parameters
        try {
            const url = new URL(replacePlaceholders(item.path), "http://dummybase");
            const queryParams = url.searchParams;

            queryParams.forEach((value, name) => {
                parameters.push({
                    name: name,
                    in: "query",
                    required: false, // Or determine based on logic
                    schema: { type: "string", example: value },
                });
            });
        } catch (_e) {
            // unparseable placeholder URLs
            printMsg(
                MSG.Err,
                `[!] Failed to parse: ${item.path} as URL for query parameter extraction, skipping query params.`
            );
        }

        // Build a location description for server action entries.
        let locationDescription: string | undefined;
        if (item.serverActionCallFile || item.functionFile) {
            const defLoc = `chunk ${item.chunkId} at ${item.functionFile}:${item.functionFileLine}`;
            const callLoc = item.serverActionCallFile
                ? `chunk ${item.serverActionCallChunkId} at ${item.serverActionCallFile}:${item.serverActionCallLine}`
                : undefined;
            locationDescription = `Defined in ${defLoc}`;
            if (callLoc && callLoc !== `chunk ${item.chunkId} at ${item.functionFile}:${item.functionFileLine}`) {
                locationDescription += `\nArguments from ${callLoc}`;
            } else if (callLoc) {
                locationDescription += `\nArguments from ${callLoc}`;
            }
        }

        const operationObject: OperationObject = {
            summary: item.summary || `${pathKey}`,
            ...(locationDescription ? { description: locationDescription } : {}),
            responses: {
                "200": {
                    description: "Successful response. The actual response will vary.",
                },
            },
            tags: item.collectionFolder
                ? [item.collectionFolder]
                : globalsUtil.getOpenapiChunkTag()
                  ? [item.chunkId]
                  : [],
        };

        if (!methodIsValid) {
            (operationObject as any).description =
                `Note: original HTTP method ${JSON.stringify(item.method)} could not be determined; defaulted to GET — verify before use.`;
        }

        if (parameters.length > 0) {
            operationObject.parameters = parameters;
        }

        if (item.body) {
            let requestBody: RequestBody;
            try {
                const body = JSON.parse(item.body);
                if (Array.isArray(body)) {
                    // JSON-array body (e.g. Next.js Server Action arguments sent as
                    // text/plain).  Represent as a raw string with the parsed array
                    // as the example so tools show the actual expected shape.
                    requestBody = {
                        content: {
                            "text/plain": {
                                schema: { type: "string" },
                                example: item.body,
                            },
                        },
                    };
                } else if (typeof body === "object" && body !== null) {
                    const properties: RequestBody["content"]["application/json"]["schema"]["properties"] = {};
                    for (const key in body) {
                        const value = body[key];
                        const type = getOpenApiType(value);
                        properties[key] = {
                            type: type,
                            example: value,
                        };
                        if (value === null) {
                            properties[key].nullable = true;
                        }
                    }
                    requestBody = {
                        content: {
                            "application/json": {
                                schema: {
                                    type: "object",
                                    properties: properties,
                                },
                            },
                        },
                    };
                } else {
                    throw new Error("Body is not a JSON object.");
                }
            } catch (error) {
                // Fallback for non-JSON bodies
                requestBody = {
                    content: {
                        "application/json": {
                            schema: { type: "string" },
                            example: item.body,
                        },
                    },
                };
            }
            operationObject.requestBody = requestBody;
        }

        spec.paths[pathKey][method] = operationObject;
    }

    return spec;
};
