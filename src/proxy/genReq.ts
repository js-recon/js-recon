import {
    APIGatewayClient,
    CreateResourceCommand,
    GetResourcesCommand,
    PutMethodCommand,
    PutIntegrationCommand,
    //   CreateDeploymentCommand,
    //   CreateStageCommand,
    PutIntegrationResponseCommand,
    PutMethodResponseCommand,
    TestInvokeMethodCommand,
    DeleteResourceCommand,
} from "@aws-sdk/client-api-gateway";
import chalk from "chalk";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import * as globals from "../utility/globals.js";
import { progressError } from "../utility/progressLog.js";
import { readAwsGatewayMap } from "./awsConfig.js";

const AWS_CLEANUP_TIMEOUT_MS = 5000;
const AWS_CLEANUP_MAX_ATTEMPTS = 3;
const AWS_CLEANUP_RETRY_DELAY_MS = 100;
const AWS_CLEANUP_ABSENCE_GRACE_MS = 30_000;
const AWS_CLEANUP_MAX_PAGES = 100;
const AWS_CLEANUP_LEASE_MS = 5 * 60_000;
const AWS_OPERATION_TIMEOUT_MS = 4 * 60_000;
const AWS_CLEANUP_RETRY_BASE_MS = 30_000;
const AWS_CLEANUP_RETRY_MAX_MS = 15 * 60_000;
const cleanupReplayLocks = new Map<string, Promise<void>>();

interface AwsCleanupRecord {
    readonly version: 1;
    readonly recordId: string;
    readonly recordedAt: string;
    readonly leaseExpiresAt: string;
    readonly nextRetryAt: string;
    readonly retryCount: number;
    readonly gatewayId: string;
    readonly region: string;
    readonly resourcePathPart: string;
    readonly resourceId?: string;
}

type ReconciliationOutcome = "deleted" | "absent" | "unresolved";

const isCleanupRecord = (value: unknown): value is AwsCleanupRecord => {
    if (typeof value !== "object" || value === null) return false;
    const candidate = value as Partial<Record<keyof AwsCleanupRecord, unknown>>;
    return (
        candidate.version === 1 &&
        typeof candidate.recordId === "string" &&
        /^[0-9a-f-]{36}$/i.test(candidate.recordId) &&
        typeof candidate.recordedAt === "string" &&
        Number.isFinite(Date.parse(candidate.recordedAt)) &&
        typeof candidate.leaseExpiresAt === "string" &&
        Number.isFinite(Date.parse(candidate.leaseExpiresAt)) &&
        typeof candidate.nextRetryAt === "string" &&
        Number.isFinite(Date.parse(candidate.nextRetryAt)) &&
        typeof candidate.retryCount === "number" &&
        Number.isSafeInteger(candidate.retryCount) &&
        candidate.retryCount >= 0 &&
        typeof candidate.gatewayId === "string" &&
        typeof candidate.region === "string" &&
        typeof candidate.resourcePathPart === "string" &&
        /^[0-9a-f]{32}$/i.test(candidate.resourcePathPart) &&
        (candidate.resourceId === undefined ||
            (typeof candidate.resourceId === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(candidate.resourceId)))
    );
};

const withCleanupReplaySingleFlight = async (key: string, work: () => Promise<void>): Promise<void> => {
    const existing = cleanupReplayLocks.get(key);
    if (existing) return existing;
    const current = work();
    cleanupReplayLocks.set(key, current);
    try {
        await current;
    } finally {
        if (cleanupReplayLocks.get(key) === current) cleanupReplayLocks.delete(key);
    }
};

/**
 * Utility function to pause execution for a specified duration.
 *
 * @param ms - Number of milliseconds to sleep
 * @returns Promise that resolves after the specified delay
 */
const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(signal.reason);
            return;
        }
        const finish = () => {
            clearTimeout(timeout);
            signal?.removeEventListener("abort", cancel);
            resolve();
        };
        const cancel = () => {
            clearTimeout(timeout);
            reject(signal?.reason);
        };
        const timeout = setTimeout(finish, ms);
        signal?.addEventListener("abort", cancel, { once: true });
    });

/**
 * Given a URL, generates a new API Gateway for it and returns the response of the URL.
 * @param {string} url The URL to generate an API Gateway for.
 * @param {object} [headers] The headers to include in the request.
 * @param {AbortSignal} [signal] Cancels pending AWS operations and retry delays.
 * @returns {Promise<string>} The response of the URL.
 */
const get = async (url: string, headers: Record<string, string> = {}, signal?: AbortSignal): Promise<string> => {
    if (signal?.aborted) throw signal.reason;

    // read the aws gateway map from the proxy config file
    const config = (() => {
        try {
            return readAwsGatewayMap(globals.getProxyConfigFile());
        } catch (error) {
            throw new Error(`Failed to read or parse proxy config file: ${error.message}`);
        }
    })();
    const gatewayNames = Object.keys(config);
    if (gatewayNames.length === 0) {
        throw new Error("No AWS API Gateway configuration is available");
    }
    const apiGateway = gatewayNames[Math.floor(Math.random() * gatewayNames.length)];
    const gateway = config[apiGateway];
    const client = new APIGatewayClient({
        region: gateway.region,
        credentials: {
            accessKeyId: gateway.access_key,
            secretAccessKey: gateway.secret_key,
        },
    });
    const operationController = new AbortController();
    const operationTimeout = setTimeout(
        () =>
            operationController.abort(
                new DOMException("AWS API Gateway operation exceeded its ownership lease budget", "TimeoutError")
            ),
        AWS_OPERATION_TIMEOUT_MS
    );
    operationTimeout.unref?.();
    const operationSignal = signal ? AbortSignal.any([signal, operationController.signal]) : operationController.signal;
    const sendOptions = { abortSignal: operationSignal };
    const operationId = randomUUID();
    // Derived from the URL alone (not operationId) so repeat requests to the same
    // URL resolve to the same pathPart, letting the existing-resource lookup below
    // reuse an already-provisioned resource instead of creating a new one every call.
    const resourcePathPart = createHash("sha256").update(url).digest("hex").slice(0, 32);
    const cleanupOptions = () => ({ abortSignal: AbortSignal.timeout(AWS_CLEANUP_TIMEOUT_MS) });
    const cleanupDirectory = `${globals.getProxyConfigFile()}.cleanup`;
    const cleanupRecordPath = (recordId: string): string => `${cleanupDirectory}/${recordId}.json`;

    const persistCleanupRecord = (record: AwsCleanupRecord): boolean => {
        const recordPath = cleanupRecordPath(record.recordId);
        const temporaryPath = `${recordPath}.${process.pid}.${randomUUID()}.tmp`;
        try {
            fs.mkdirSync(cleanupDirectory, { recursive: true, mode: 0o700 });
            fs.writeFileSync(temporaryPath, JSON.stringify(record), { encoding: "utf8", mode: 0o600, flag: "wx" });
            fs.renameSync(temporaryPath, recordPath);
            return true;
        } catch (err) {
            progressError(chalk.red(`[!] Failed to record pending AWS API Gateway cleanup: ${err}`));
            return false;
        } finally {
            try {
                if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
            } catch {
                // A stale temporary file has no ownership authority and can be ignored.
            }
        }
    };

    const retireCleanupRecord = (record: AwsCleanupRecord): void => {
        try {
            fs.unlinkSync(cleanupRecordPath(record.recordId));
        } catch (err) {
            const code = typeof err === "object" && err !== null ? Reflect.get(err, "code") : undefined;
            if (code !== "ENOENT") {
                progressError(chalk.red(`[!] Failed to retire completed AWS API Gateway cleanup record: ${err}`));
            }
        }
    };

    const beginCleanupOwnership = (): AwsCleanupRecord => {
        const recordedAt = new Date();
        const record: AwsCleanupRecord = Object.freeze({
            version: 1,
            recordId: operationId,
            recordedAt: recordedAt.toISOString(),
            leaseExpiresAt: new Date(recordedAt.getTime() + AWS_CLEANUP_LEASE_MS).toISOString(),
            nextRetryAt: new Date(recordedAt.getTime() + AWS_CLEANUP_LEASE_MS).toISOString(),
            retryCount: 0,
            gatewayId: gateway.id,
            region: gateway.region,
            resourcePathPart,
        });
        if (!persistCleanupRecord(record)) {
            throw new Error("Refusing to create a temporary AWS API Gateway resource without a cleanup record");
        }
        return record;
    };

    const loadCleanupRecords = (): readonly AwsCleanupRecord[] => {
        if (!fs.existsSync(cleanupDirectory)) return [];
        try {
            return Object.freeze(
                fs
                    .readdirSync(cleanupDirectory, { withFileTypes: true })
                    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
                    .flatMap((entry) => {
                        try {
                            const parsed: unknown = JSON.parse(
                                fs.readFileSync(`${cleanupDirectory}/${entry.name}`, "utf8")
                            );
                            return isCleanupRecord(parsed) ? [Object.freeze({ ...parsed })] : [];
                        } catch {
                            return [];
                        }
                    })
            );
        } catch (err) {
            progressError(chalk.red(`[!] Failed to read pending AWS API Gateway cleanup records: ${err}`));
            return [];
        }
    };

    const deferCleanupRecord = (record: AwsCleanupRecord): void => {
        const retryDelay = Math.min(
            AWS_CLEANUP_RETRY_BASE_MS * 2 ** Math.min(record.retryCount, 10),
            AWS_CLEANUP_RETRY_MAX_MS
        );
        persistCleanupRecord(
            Object.freeze({
                ...record,
                retryCount: record.retryCount + 1,
                nextRetryAt: new Date(Date.now() + retryDelay).toISOString(),
            })
        );
    };

    const isNotFoundError = (err: unknown): boolean => {
        if (typeof err !== "object" || err === null) return false;
        const candidate = err as {
            readonly name?: unknown;
            readonly $metadata?: { readonly httpStatusCode?: unknown };
        };
        return candidate.name === "NotFoundException" || candidate.$metadata?.httpStatusCode === 404;
    };

    const deleteResource = async (
        resourceId: string,
        cleanupClient: APIGatewayClient = client,
        restApiId: string = gateway.id
    ): Promise<boolean> => {
        const deleteResourceCommand = new DeleteResourceCommand({
            restApiId,
            resourceId,
        });
        let lastError: unknown;
        for (let attempt = 1; attempt <= AWS_CLEANUP_MAX_ATTEMPTS; attempt++) {
            try {
                // Cleanup deliberately gets its own request rather than the cancelled
                // discovery signal so an aborted run does not leak temporary resources.
                await cleanupClient.send(deleteResourceCommand, cleanupOptions());
                return true;
            } catch (err) {
                if (isNotFoundError(err)) return true;
                lastError = err;
                if (attempt < AWS_CLEANUP_MAX_ATTEMPTS) {
                    await sleep(AWS_CLEANUP_RETRY_DELAY_MS * attempt);
                }
            }
        }
        progressError(chalk.red(`[!] Error when deleting temporary AWS API Gateway resource: ${lastError}`));
        return false;
    };

    const listCleanupResources = async (
        cleanupClient: APIGatewayClient = client,
        restApiId: string = gateway.id
    ): Promise<readonly { readonly id?: string; readonly pathPart?: string }[]> => {
        const items: { readonly id?: string; readonly pathPart?: string }[] = [];
        const seenPositions = new Set<string>();
        let position: string | undefined;
        for (let page = 0; page < AWS_CLEANUP_MAX_PAGES; page++) {
            const resources = await cleanupClient.send(
                new GetResourcesCommand({ restApiId, limit: 500, ...(position ? { position } : {}) }),
                cleanupOptions()
            );
            items.push(...(resources.items ?? []));
            if (!resources.position) return Object.freeze(items);
            if (seenPositions.has(resources.position)) {
                throw new Error("AWS API Gateway returned a repeated cleanup pagination cursor");
            }
            seenPositions.add(resources.position);
            position = resources.position;
        }
        throw new Error(`AWS API Gateway cleanup exceeded ${AWS_CLEANUP_MAX_PAGES} resource pages`);
    };

    const reconcileResource = async (
        expectedPathPart: string,
        expectedResourceId?: string
    ): Promise<ReconciliationOutcome> => {
        let lastError: unknown;
        let observedCompleteListing = false;
        for (let attempt = 1; attempt <= AWS_CLEANUP_MAX_ATTEMPTS; attempt++) {
            try {
                const resources = await listCleanupResources();
                observedCompleteListing = true;
                const resourceId = resources.find(
                    (item) =>
                        item.pathPart === expectedPathPart &&
                        (expectedResourceId === undefined || item.id === expectedResourceId)
                )?.id;
                if (resourceId) {
                    return (await deleteResource(resourceId)) ? "deleted" : "unresolved";
                }
            } catch (err) {
                lastError = err;
            }
            if (attempt < AWS_CLEANUP_MAX_ATTEMPTS) {
                await sleep(AWS_CLEANUP_RETRY_DELAY_MS * attempt);
            }
        }
        if (!observedCompleteListing && lastError !== undefined) {
            progressError(chalk.red(`[!] Error when reconciling temporary AWS API Gateway resource: ${lastError}`));
            return "unresolved";
        }
        return "absent";
    };

    const replayGatewayRecords = async (
        records: readonly AwsCleanupRecord[],
        replayGateway: typeof gateway,
        replayClient: APIGatewayClient
    ): Promise<void> => {
        let resources: readonly { readonly id?: string; readonly pathPart?: string }[] | null = null;
        let lastError: unknown;
        for (let attempt = 1; attempt <= AWS_CLEANUP_MAX_ATTEMPTS; attempt++) {
            try {
                resources = await listCleanupResources(replayClient, replayGateway.id);
                break;
            } catch (err) {
                lastError = err;
                if (attempt < AWS_CLEANUP_MAX_ATTEMPTS) {
                    await sleep(AWS_CLEANUP_RETRY_DELAY_MS * attempt);
                }
            }
        }
        if (!resources) {
            progressError(
                chalk.red(
                    `[!] Error when replaying pending AWS API Gateway cleanup for ${replayGateway.id}: ${lastError}`
                )
            );
            for (const record of records) deferCleanupRecord(record);
            return;
        }

        for (const record of records) {
            const resourceId = resources.find(
                (item) =>
                    item.pathPart === record.resourcePathPart &&
                    (record.resourceId === undefined || item.id === record.resourceId)
            )?.id;
            if (resourceId) {
                if (await deleteResource(resourceId, replayClient, replayGateway.id)) {
                    retireCleanupRecord(record);
                } else {
                    deferCleanupRecord(record);
                }
                continue;
            }
            const oldEnoughToConfirmAbsence =
                Date.now() - Date.parse(record.recordedAt) >= AWS_CLEANUP_ABSENCE_GRACE_MS;
            if (oldEnoughToConfirmAbsence) retireCleanupRecord(record);
        }
    };

    const replayCleanupRecords = async (): Promise<void> =>
        withCleanupReplaySingleFlight(cleanupDirectory, async () => {
            const now = Date.now();
            const expiredRecords = loadCleanupRecords().filter(
                (record) => Date.parse(record.leaseExpiresAt) <= now && Date.parse(record.nextRetryAt) <= now
            );
            if (expiredRecords.length === 0) return;

            const replayedGateways = new Set<string>();
            for (const replayGateway of Object.values(config)) {
                const gatewayKey = `${replayGateway.region}\0${replayGateway.id}`;
                if (replayedGateways.has(gatewayKey)) continue;
                replayedGateways.add(gatewayKey);
                const records = expiredRecords.filter(
                    (record) => record.gatewayId === replayGateway.id && record.region === replayGateway.region
                );
                if (records.length === 0) continue;

                const useCurrentClient = replayGateway === gateway;
                const replayClient = useCurrentClient
                    ? client
                    : new APIGatewayClient({
                          region: replayGateway.region,
                          credentials: {
                              accessKeyId: replayGateway.access_key,
                              secretAccessKey: replayGateway.secret_key,
                          },
                      });
                try {
                    await replayGatewayRecords(records, replayGateway, replayClient);
                } finally {
                    if (!useCurrentClient) replayClient.destroy();
                }
            }
        });

    const reconcileAmbiguousResource = async (record: AwsCleanupRecord): Promise<void> => {
        const outcome = await reconcileResource(record.resourcePathPart);
        if (outcome === "deleted") {
            retireCleanupRecord(record);
        } else if (outcome === "unresolved") {
            progressError(
                chalk.red(
                    `[!] Temporary AWS API Gateway ownership remains pending in ${cleanupRecordPath(record.recordId)}`
                )
            );
        }
    };

    const configureResource = async (resourceId: string): Promise<void> => {
        await client.send(
            new PutMethodCommand({
                restApiId: gateway.id,
                resourceId,
                httpMethod: "GET",
                authorizationType: "NONE",
                requestParameters: {
                    "method.request.header.RSC": false,
                    "method.request.header.User-Agent": false,
                    "method.request.header.Referer": false,
                    "method.request.header.Accept": false,
                    "method.request.header.Accept-Language": false,
                    "method.request.header.Accept-Encoding": false,
                    "method.request.header.Content-Type": false,
                    "method.request.header.Content-Length": false,
                    "method.request.header.Origin": false,
                    "method.request.header.X-Forwarded-For": false,
                    "method.request.header.X-Forwarded-Host": false,
                    "method.request.header.X-IP": false,
                    "method.request.header.X-Forwarded-Proto": false,
                    "method.request.header.X-Forwarded-Port": false,
                    "method.request.header.Sec-Fetch-Site": false,
                    "method.request.header.Sec-Fetch-Mode": false,
                    "method.request.header.Sec-Fetch-Dest": false,
                },
            }),
            sendOptions
        );
        await sleep(100, operationSignal);

        await client.send(
            new PutIntegrationCommand({
                restApiId: gateway.id,
                resourceId,
                httpMethod: "GET",
                integrationHttpMethod: "GET",
                type: "HTTP",
                timeoutInMillis: 29000,
                uri: url,
            }),
            sendOptions
        );
        await sleep(100, operationSignal);

        await client.send(
            new PutMethodResponseCommand({
                httpMethod: "GET",
                resourceId,
                restApiId: gateway.id,
                statusCode: "200",
            }),
            sendOptions
        );
        await sleep(100, operationSignal);

        await client.send(
            new PutIntegrationResponseCommand({
                httpMethod: "GET",
                resourceId,
                restApiId: gateway.id,
                statusCode: "200",
            }),
            sendOptions
        );
        await sleep(100, operationSignal);
    };

    const createResource = async (
        parentId: string
    ): Promise<Readonly<{ id: string; cleanupRecord: AwsCleanupRecord }>> => {
        const initialCleanupRecord = beginCleanupOwnership();
        let resourceId: string;
        try {
            const created = await client.send(
                new CreateResourceCommand({
                    restApiId: gateway.id,
                    parentId,
                    pathPart: resourcePathPart,
                }),
                sendOptions
            );
            if (!created.id) throw new Error("AWS API Gateway did not return a resource ID");
            resourceId = created.id;
        } catch (error) {
            // CreateResource can commit remotely even when cancellation or a
            // transport failure loses its response. Reconcile by deterministic
            // pathPart before returning the original failure.
            await reconcileAmbiguousResource(initialCleanupRecord);
            throw error;
        }

        const cleanupRecord: AwsCleanupRecord = Object.freeze({
            ...initialCleanupRecord,
            resourceId,
        });
        // The original pathPart-only record remains sufficient for replay if
        // this best-effort enrichment cannot be persisted.
        persistCleanupRecord(cleanupRecord);

        try {
            await sleep(200, operationSignal);
            await configureResource(resourceId);
            return Object.freeze({ id: resourceId, cleanupRecord });
        } catch (error) {
            if (await deleteResource(resourceId)) retireCleanupRecord(cleanupRecord);
            throw error;
        }
    };

    try {
        await replayCleanupRecords();
        const resourceResponse = await client.send(
            new GetResourcesCommand({ restApiId: gateway.id, limit: 999999999 }),
            sendOptions
        );
        await sleep(200, operationSignal);
        const resources = resourceResponse.items ?? [];
        const existingResource = resources.find((item) => item.pathPart === resourcePathPart);
        const rootId = resources.find((item) => item.path === "/")?.id ?? resources[0]?.parentId;
        if (!existingResource?.id && !rootId) {
            throw new Error("AWS API Gateway did not return a root resource ID");
        }

        const resource = existingResource?.id
            ? { id: existingResource.id, cleanupRecord: null }
            : await createResource(rootId!);

        try {
            const invoked = await client.send(
                new TestInvokeMethodCommand({
                    httpMethod: "GET",
                    resourceId: resource.id,
                    restApiId: gateway.id,
                    headers,
                }),
                sendOptions
            );
            await sleep(100, operationSignal);
            return invoked.body ?? "";
        } finally {
            if (resource.cleanupRecord && (await deleteResource(resource.id))) {
                retireCleanupRecord(resource.cleanupRecord);
            }
        }
    } finally {
        clearTimeout(operationTimeout);
        client.destroy();
    }
};

export { get };
