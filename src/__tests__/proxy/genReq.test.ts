import { createHash } from "node:crypto";
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const awsHarness = vi.hoisted(() => ({
    destroy: vi.fn(),
    progressError: vi.fn(),
    proxyConfigFile: ".proxy_config.json",
    readGatewayMap: vi.fn(),
    send: vi.fn(),
}));

vi.mock("@aws-sdk/client-api-gateway", () => {
    class Command {
        constructor(readonly input: unknown) {}
    }

    return {
        APIGatewayClient: class {
            send = awsHarness.send;
            destroy = awsHarness.destroy;
        },
        CreateResourceCommand: class CreateResourceCommand extends Command {},
        DeleteResourceCommand: class DeleteResourceCommand extends Command {},
        GetResourcesCommand: class GetResourcesCommand extends Command {},
        PutIntegrationCommand: class PutIntegrationCommand extends Command {},
        PutIntegrationResponseCommand: class PutIntegrationResponseCommand extends Command {},
        PutMethodCommand: class PutMethodCommand extends Command {},
        PutMethodResponseCommand: class PutMethodResponseCommand extends Command {},
        TestInvokeMethodCommand: class TestInvokeMethodCommand extends Command {},
    };
});

vi.mock("../../proxy/awsConfig.js", () => ({
    readAwsGatewayMap: awsHarness.readGatewayMap,
}));

vi.mock("../../utility/globals.js", () => ({
    getProxyConfigFile: () => awsHarness.proxyConfigFile,
}));

vi.mock("../../utility/progressLog.js", () => ({
    progressError: awsHarness.progressError,
}));

import { get } from "../../proxy/genReq.js";

const commandName = (command: object): string => command.constructor.name;
let temporaryDirectory: string;

const cleanupDirectory = (): string => `${awsHarness.proxyConfigFile}.cleanup`;
const readCleanupRecords = (): string[] =>
    fs.existsSync(cleanupDirectory())
        ? fs.readdirSync(cleanupDirectory()).map((name) => fs.readFileSync(`${cleanupDirectory()}/${name}`, "utf8"))
        : [];

const writeCleanupRecord = (record: object): string => {
    fs.mkdirSync(cleanupDirectory(), { recursive: true });
    const recordPath = `${cleanupDirectory()}/${Reflect.get(record, "recordId")}.json`;
    fs.writeFileSync(recordPath, JSON.stringify(record));
    return recordPath;
};

beforeEach(() => {
    vi.useFakeTimers();
    temporaryDirectory = fs.mkdtempSync("/tmp/js-recon-aws-cleanup-");
    awsHarness.proxyConfigFile = `${temporaryDirectory}/proxy.json`;
    awsHarness.destroy.mockReset();
    awsHarness.progressError.mockReset();
    awsHarness.readGatewayMap.mockReset();
    awsHarness.send.mockReset();
    awsHarness.readGatewayMap.mockReturnValue({
        primary: {
            id: "gateway-id",
            name: "primary",
            description: "test",
            created_at: 0,
            region: "us-east-1",
            access_key: "test-access-key",
            secret_key: "test-secret-key",
        },
    });
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe("AWS API Gateway request cancellation", () => {
    it("derives the same pathPart for repeat requests to the same URL, enabling resource reuse", async () => {
        const createdPathParts: string[] = [];
        awsHarness.send.mockImplementation(async (command) => {
            switch (commandName(command)) {
                case "GetResourcesCommand":
                    return { items: [{ id: "root-id", path: "/" }] };
                case "CreateResourceCommand":
                    createdPathParts.push(command.input.pathPart);
                    return { id: `resource-${createdPathParts.length}` };
                case "TestInvokeMethodCommand":
                    return { body: "const proxied = true;" };
                default:
                    return {};
            }
        });

        const requests = Promise.all([get("https://example.test/shared.js"), get("https://example.test/shared.js")]);
        await vi.runAllTimersAsync();
        await requests;

        // pathPart must be deterministic per URL (regression test for issue #128, where
        // mixing a fresh randomUUID into the hash broke the existing-resource reuse lookup).
        expect(createdPathParts).toHaveLength(2);
        expect(new Set(createdPathParts).size).toBe(1);

        // Cleanup-record ownership (recordId) still stays distinct per call.
        const records = readCleanupRecords().map((serialized) => JSON.parse(serialized));
        expect(new Set(records.map((record) => record.recordId)).size).toBe(records.length);
    });

    it("reuses an already-provisioned resource for a URL instead of creating a new one", async () => {
        const expectedPathPart = createHash("sha256")
            .update("https://example.test/reused.js")
            .digest("hex")
            .slice(0, 32);
        const createResourceCalls: string[] = [];
        awsHarness.send.mockImplementation(async (command) => {
            switch (commandName(command)) {
                case "GetResourcesCommand":
                    return {
                        items: [
                            { id: "root-id", path: "/" },
                            { id: "existing-resource-id", pathPart: expectedPathPart },
                        ],
                    };
                case "CreateResourceCommand":
                    createResourceCalls.push(command.input.pathPart);
                    return { id: "resource-should-not-be-created" };
                case "TestInvokeMethodCommand":
                    return { body: "const proxied = true;" };
                default:
                    return {};
            }
        });

        const request = get("https://example.test/reused.js");
        await vi.runAllTimersAsync();
        await request;

        expect(createResourceCalls).toHaveLength(0);
    });

    it("passes the caller signal to AWS work and deletes its temporary resource", async () => {
        const controller = new AbortController();
        awsHarness.send.mockImplementation(async (command) => {
            switch (commandName(command)) {
                case "GetResourcesCommand":
                    return { items: [{ id: "root-id", path: "/" }] };
                case "CreateResourceCommand":
                    return { id: "temporary-resource-id" };
                case "TestInvokeMethodCommand":
                    return { body: "const proxied = true;" };
                default:
                    return {};
            }
        });

        const request = get("https://example.test/chunk.js", { Accept: "text/javascript" }, controller.signal);
        await vi.runAllTimersAsync();

        await expect(request).resolves.toBe("const proxied = true;");
        const operationalCalls = awsHarness.send.mock.calls.filter(
            ([command]) => commandName(command) !== "DeleteResourceCommand"
        );
        expect(operationalCalls.every(([, options]) => options?.abortSignal instanceof AbortSignal)).toBe(true);
        const deleteCall = awsHarness.send.mock.calls.find(
            ([command]) => commandName(command) === "DeleteResourceCommand"
        );
        expect(deleteCall?.[1]?.abortSignal).toBeInstanceOf(AbortSignal);
        expect(deleteCall?.[1]?.abortSignal).not.toBe(controller.signal);
        expect(awsHarness.destroy).toHaveBeenCalledTimes(1);
    });

    it("cancels setup work but still cleans up the resource without the cancelled signal", async () => {
        const controller = new AbortController();
        let markSetupStarted!: () => void;
        const setupStarted = new Promise<void>((resolve) => {
            markSetupStarted = resolve;
        });
        awsHarness.send.mockImplementation((command, options) => {
            switch (commandName(command)) {
                case "GetResourcesCommand":
                    return Promise.resolve({ items: [{ id: "root-id", path: "/" }] });
                case "CreateResourceCommand":
                    return Promise.resolve({ id: "temporary-resource-id" });
                case "PutMethodCommand":
                    markSetupStarted();
                    return new Promise((_resolve, reject) => {
                        options?.abortSignal?.addEventListener("abort", () => reject(options.abortSignal.reason), {
                            once: true,
                        });
                    });
                default:
                    return Promise.resolve({});
            }
        });

        const request = get("https://example.test/chunk.js", {}, controller.signal);
        await vi.advanceTimersByTimeAsync(400);
        await setupStarted;
        controller.abort();

        await expect(request).rejects.toMatchObject({ name: "AbortError" });
        const deleteCall = awsHarness.send.mock.calls.find(
            ([command]) => commandName(command) === "DeleteResourceCommand"
        );
        expect(deleteCall?.[1]?.abortSignal).toBeInstanceOf(AbortSignal);
        expect(deleteCall?.[1]?.abortSignal).not.toBe(controller.signal);
        expect(awsHarness.destroy).toHaveBeenCalledTimes(1);
    });

    it("bounds owned AWS work below the cleanup lease duration", async () => {
        let markSetupStarted!: () => void;
        const setupStarted = new Promise<void>((resolve) => {
            markSetupStarted = resolve;
        });
        let operationSignal: AbortSignal | undefined;
        awsHarness.send.mockImplementation((command, options) => {
            switch (commandName(command)) {
                case "GetResourcesCommand":
                    return Promise.resolve({ items: [{ id: "root-id", path: "/" }] });
                case "CreateResourceCommand":
                    return Promise.resolve({ id: "temporary-resource-id" });
                case "PutMethodCommand":
                    operationSignal = options?.abortSignal;
                    markSetupStarted();
                    return new Promise((_resolve, reject) => {
                        operationSignal?.addEventListener("abort", () => reject(operationSignal?.reason), {
                            once: true,
                        });
                    });
                default:
                    return Promise.resolve({});
            }
        });

        const request = get("https://example.test/chunk.js");
        await vi.advanceTimersByTimeAsync(400);
        await setupStarted;
        const [serializedRecord] = readCleanupRecords();
        const record = JSON.parse(serializedRecord);
        expect(Date.parse(record.leaseExpiresAt) - Date.parse(record.recordedAt)).toBe(5 * 60_000);

        const rejection = expect(request).rejects.toMatchObject({ name: "TimeoutError" });
        await vi.advanceTimersByTimeAsync(4 * 60_000);

        await rejection;
        expect(operationSignal?.aborted).toBe(true);
        expect(readCleanupRecords()).toEqual([]);
    });

    it("reconciles and removes a resource after an ambiguous create failure", async () => {
        let createdPathPart = "";
        let resourceReads = 0;
        awsHarness.send.mockImplementation((command) => {
            switch (commandName(command)) {
                case "GetResourcesCommand":
                    resourceReads++;
                    return Promise.resolve({
                        items:
                            resourceReads < 4
                                ? [{ id: "root-id", path: "/" }]
                                : [
                                      { id: "root-id", path: "/" },
                                      { id: "ambiguous-resource-id", pathPart: createdPathPart },
                                  ],
                    });
                case "CreateResourceCommand":
                    createdPathPart = command.input.pathPart;
                    return Promise.reject(new Error("response lost after commit"));
                default:
                    return Promise.resolve({});
            }
        });

        const request = get("https://example.test/chunk.js");
        const rejection = expect(request).rejects.toThrow("response lost after commit");
        await vi.runAllTimersAsync();

        await rejection;
        expect(resourceReads).toBe(4);
        expect(awsHarness.send.mock.calls.map(([command]) => commandName(command))).toContain("DeleteResourceCommand");
        expect(awsHarness.destroy).toHaveBeenCalledTimes(1);
    });

    it("retries transient resource deletion failures", async () => {
        let deleteAttempts = 0;
        awsHarness.send.mockImplementation((command) => {
            switch (commandName(command)) {
                case "GetResourcesCommand":
                    return Promise.resolve({ items: [{ id: "root-id", path: "/" }] });
                case "CreateResourceCommand":
                    return Promise.resolve({ id: "temporary-resource-id" });
                case "TestInvokeMethodCommand":
                    return Promise.resolve({ body: "const proxied = true;" });
                case "DeleteResourceCommand":
                    deleteAttempts++;
                    return deleteAttempts < 3
                        ? Promise.reject(new Error("transient delete failure"))
                        : Promise.resolve({});
                default:
                    return Promise.resolve({});
            }
        });

        const request = get("https://example.test/chunk.js");
        await vi.runAllTimersAsync();

        await expect(request).resolves.toBe("const proxied = true;");
        expect(deleteAttempts).toBe(3);
        expect(awsHarness.progressError).not.toHaveBeenCalled();
    });

    it("journals a resource ID when deletion remains unavailable", async () => {
        awsHarness.send.mockImplementation((command) => {
            switch (commandName(command)) {
                case "GetResourcesCommand":
                    return Promise.resolve({ items: [{ id: "root-id", path: "/" }] });
                case "CreateResourceCommand":
                    return Promise.resolve({ id: "temporary-resource-id" });
                case "TestInvokeMethodCommand":
                    return Promise.resolve({ body: "const proxied = true;" });
                case "DeleteResourceCommand":
                    return Promise.reject(new Error("persistent delete failure"));
                default:
                    return Promise.resolve({});
            }
        });

        const request = get("https://example.test/chunk.js");
        await vi.runAllTimersAsync();

        await expect(request).resolves.toBe("const proxied = true;");
        const records = readCleanupRecords();
        expect(records).toHaveLength(1);
        const serializedRecord = records[0];
        expect(serializedRecord).toContain('"resourceId":"temporary-resource-id"');
    });

    it("records unresolved ambiguous creates without persisting credentials", async () => {
        awsHarness.send.mockImplementation((command) => {
            switch (commandName(command)) {
                case "GetResourcesCommand":
                    return Promise.resolve({ items: [{ id: "root-id", path: "/" }] });
                case "CreateResourceCommand":
                    return Promise.reject(new Error("response lost after commit"));
                default:
                    return Promise.resolve({});
            }
        });

        const request = get("https://example.test/chunk.js");
        const rejection = expect(request).rejects.toThrow("response lost after commit");
        await vi.runAllTimersAsync();

        await rejection;
        const records = readCleanupRecords();
        expect(records).toHaveLength(1);
        const serializedRecord = records[0];
        expect(serializedRecord).not.toContain("test-access-key");
        expect(serializedRecord).not.toContain("test-secret-key");
    });

    it("replays and acknowledges cleanup ownership from a prior run", async () => {
        const pendingPath = writeCleanupRecord({
            version: 1,
            recordId: "11111111-1111-4111-8111-111111111111",
            recordedAt: "2020-01-01T00:00:00.000Z",
            leaseExpiresAt: "2020-01-01T00:10:00.000Z",
            nextRetryAt: "2020-01-01T00:10:00.000Z",
            retryCount: 0,
            gatewayId: "gateway-id",
            region: "us-east-1",
            resourcePathPart: "a".repeat(32),
            resourceId: "orphan-resource-id",
        });
        const secondPendingPath = writeCleanupRecord({
            version: 1,
            recordId: "33333333-3333-4333-8333-333333333333",
            recordedAt: "2020-01-01T00:00:00.000Z",
            leaseExpiresAt: "2020-01-01T00:10:00.000Z",
            nextRetryAt: "2020-01-01T00:10:00.000Z",
            retryCount: 0,
            gatewayId: "gateway-id",
            region: "us-east-1",
            resourcePathPart: "c".repeat(32),
            resourceId: "second-orphan-resource-id",
        });
        let resourceReads = 0;
        awsHarness.send.mockImplementation((command) => {
            switch (commandName(command)) {
                case "GetResourcesCommand":
                    resourceReads++;
                    return Promise.resolve({
                        items:
                            resourceReads === 1
                                ? [
                                      { id: "root-id", path: "/" },
                                      { id: "orphan-resource-id", pathPart: "a".repeat(32) },
                                      { id: "second-orphan-resource-id", pathPart: "c".repeat(32) },
                                  ]
                                : [{ id: "root-id", path: "/" }],
                    });
                case "CreateResourceCommand":
                    return Promise.resolve({ id: "current-resource-id" });
                case "TestInvokeMethodCommand":
                    return Promise.resolve({ body: "const proxied = true;" });
                default:
                    return Promise.resolve({});
            }
        });

        const request = get("https://example.test/chunk.js");
        await vi.runAllTimersAsync();

        await expect(request).resolves.toBe("const proxied = true;");
        expect(fs.existsSync(pendingPath)).toBe(false);
        expect(fs.existsSync(secondPendingPath)).toBe(false);
        expect(readCleanupRecords()).toEqual([]);
        expect(resourceReads).toBe(2);
    });

    it("retains replay ownership when deletion still fails", async () => {
        const pendingPath = writeCleanupRecord({
            version: 1,
            recordId: "22222222-2222-4222-8222-222222222222",
            recordedAt: "2020-01-01T00:00:00.000Z",
            leaseExpiresAt: "2020-01-01T00:10:00.000Z",
            nextRetryAt: "2020-01-01T00:10:00.000Z",
            retryCount: 0,
            gatewayId: "gateway-id",
            region: "us-east-1",
            resourcePathPart: "b".repeat(32),
            resourceId: "orphan-resource-id",
        });
        let deleteAttempts = 0;
        let resourceReads = 0;
        awsHarness.send.mockImplementation((command) => {
            switch (commandName(command)) {
                case "GetResourcesCommand":
                    resourceReads++;
                    return Promise.resolve({
                        items:
                            resourceReads === 1
                                ? [
                                      { id: "root-id", path: "/" },
                                      { id: "orphan-resource-id", pathPart: "b".repeat(32) },
                                  ]
                                : [{ id: "root-id", path: "/" }],
                    });
                case "CreateResourceCommand":
                    return Promise.resolve({ id: "current-resource-id" });
                case "TestInvokeMethodCommand":
                    return Promise.resolve({ body: "const proxied = true;" });
                case "DeleteResourceCommand":
                    deleteAttempts++;
                    return deleteAttempts <= 3
                        ? Promise.reject(new Error("persistent replay failure"))
                        : Promise.resolve({});
                default:
                    return Promise.resolve({});
            }
        });

        const request = get("https://example.test/chunk.js");
        await vi.runAllTimersAsync();

        await expect(request).resolves.toBe("const proxied = true;");
        expect(fs.existsSync(pendingPath)).toBe(true);
        expect(readCleanupRecords()).toHaveLength(1);
    });

    it("shares one failed replay batch and durably backs off concurrent callers", async () => {
        writeCleanupRecord({
            version: 1,
            recordId: "66666666-6666-4666-8666-666666666666",
            recordedAt: "2020-01-01T00:00:00.000Z",
            leaseExpiresAt: "2020-01-01T00:10:00.000Z",
            nextRetryAt: "2020-01-01T00:10:00.000Z",
            retryCount: 0,
            gatewayId: "gateway-id",
            region: "us-east-1",
            resourcePathPart: "f".repeat(32),
            resourceId: "orphan-resource-id",
        });
        let resourceReads = 0;
        let orphanDeleteAttempts = 0;
        let createCount = 0;
        awsHarness.send.mockImplementation((command) => {
            switch (commandName(command)) {
                case "GetResourcesCommand":
                    resourceReads++;
                    return Promise.resolve({
                        items:
                            resourceReads === 1
                                ? [
                                      { id: "root-id", path: "/" },
                                      { id: "orphan-resource-id", pathPart: "f".repeat(32) },
                                  ]
                                : [{ id: "root-id", path: "/" }],
                    });
                case "DeleteResourceCommand":
                    if (command.input.resourceId === "orphan-resource-id") {
                        orphanDeleteAttempts++;
                        return Promise.reject(new Error("persistent replay failure"));
                    }
                    return Promise.resolve({});
                case "CreateResourceCommand":
                    createCount++;
                    return Promise.resolve({ id: `current-resource-${createCount}` });
                case "TestInvokeMethodCommand":
                    return Promise.resolve({ body: "const proxied = true;" });
                default:
                    return Promise.resolve({});
            }
        });

        const requests = Promise.all(
            Array.from({ length: 5 }, (_, index) => get(`https://example.test/chunk-${index}.js`))
        );
        await vi.runAllTimersAsync();

        await expect(requests).resolves.toEqual(Array(5).fill("const proxied = true;"));
        expect(orphanDeleteAttempts).toBe(3);
        expect(resourceReads).toBe(6);
        const [serializedRecord] = readCleanupRecords();
        const record = JSON.parse(serializedRecord);
        expect(record.retryCount).toBe(1);
        expect(Date.parse(record.nextRetryAt)).toBeGreaterThan(Date.now());
    });

    it("does not replay cleanup ownership leased by another live request", async () => {
        const activeResources = new Map<string, string>();
        const deletedResources: string[] = [];
        let createCount = 0;
        let releaseFirstSetup!: () => void;
        let markFirstSetupStarted!: () => void;
        const firstSetupStarted = new Promise<void>((resolve) => {
            markFirstSetupStarted = resolve;
        });
        const firstSetupRelease = new Promise<void>((resolve) => {
            releaseFirstSetup = resolve;
        });
        awsHarness.send.mockImplementation((command) => {
            switch (commandName(command)) {
                case "GetResourcesCommand":
                    return Promise.resolve({
                        items: [
                            { id: "root-id", path: "/" },
                            ...[...activeResources].map(([pathPart, id]) => ({ id, pathPart })),
                        ],
                    });
                case "CreateResourceCommand": {
                    createCount++;
                    const id = `resource-${createCount}`;
                    activeResources.set(command.input.pathPart, id);
                    return Promise.resolve({ id });
                }
                case "PutMethodCommand":
                    if (command.input.resourceId === "resource-1") {
                        markFirstSetupStarted();
                        return firstSetupRelease;
                    }
                    return Promise.resolve({});
                case "TestInvokeMethodCommand":
                    return Promise.resolve({ body: "const proxied = true;" });
                case "DeleteResourceCommand":
                    deletedResources.push(command.input.resourceId);
                    for (const [pathPart, id] of activeResources) {
                        if (id === command.input.resourceId) activeResources.delete(pathPart);
                    }
                    return Promise.resolve({});
                default:
                    return Promise.resolve({});
            }
        });

        const firstRequest = get("https://example.test/first.js");
        await vi.advanceTimersByTimeAsync(400);
        await firstSetupStarted;

        const secondRequest = get("https://example.test/second.js");
        await vi.advanceTimersByTimeAsync(1200);
        await expect(secondRequest).resolves.toBe("const proxied = true;");
        expect(deletedResources).not.toContain("resource-1");

        releaseFirstSetup();
        await vi.advanceTimersByTimeAsync(1000);
        await expect(firstRequest).resolves.toBe("const proxied = true;");
        expect(deletedResources).toContain("resource-1");
    });

    it("replays expired ownership for every configured gateway", async () => {
        awsHarness.readGatewayMap.mockReturnValue({
            primary: {
                id: "gateway-id",
                region: "us-east-1",
                access_key: "primary-access",
                secret_key: "primary-secret",
            },
            secondary: {
                id: "secondary-gateway-id",
                region: "us-west-2",
                access_key: "secondary-access",
                secret_key: "secondary-secret",
            },
        });
        vi.spyOn(Math, "random").mockReturnValue(0);
        for (const [recordId, gatewayId, region, resourcePathPart, resourceId] of [
            ["44444444-4444-4444-8444-444444444444", "gateway-id", "us-east-1", "d".repeat(32), "orphan-a"],
            ["55555555-5555-4555-8555-555555555555", "secondary-gateway-id", "us-west-2", "e".repeat(32), "orphan-b"],
        ]) {
            writeCleanupRecord({
                version: 1,
                recordId,
                recordedAt: "2020-01-01T00:00:00.000Z",
                leaseExpiresAt: "2020-01-01T00:10:00.000Z",
                nextRetryAt: "2020-01-01T00:10:00.000Z",
                retryCount: 0,
                gatewayId,
                region,
                resourcePathPart,
                resourceId,
            });
        }
        const deletedGateways: string[] = [];
        let primaryReads = 0;
        awsHarness.send.mockImplementation((command) => {
            const gatewayId = command.input.restApiId;
            switch (commandName(command)) {
                case "GetResourcesCommand":
                    if (gatewayId === "gateway-id") primaryReads++;
                    return Promise.resolve({
                        items:
                            gatewayId === "secondary-gateway-id"
                                ? [
                                      { id: "secondary-root", path: "/" },
                                      { id: "orphan-b", pathPart: "e".repeat(32) },
                                  ]
                                : primaryReads === 1
                                  ? [
                                        { id: "root-id", path: "/" },
                                        { id: "orphan-a", pathPart: "d".repeat(32) },
                                    ]
                                  : [{ id: "root-id", path: "/" }],
                    });
                case "DeleteResourceCommand":
                    deletedGateways.push(gatewayId);
                    return Promise.resolve({});
                case "CreateResourceCommand":
                    return Promise.resolve({ id: "current-resource-id" });
                case "TestInvokeMethodCommand":
                    return Promise.resolve({ body: "const proxied = true;" });
                default:
                    return Promise.resolve({});
            }
        });

        const request = get("https://example.test/chunk.js");
        await vi.runAllTimersAsync();

        await expect(request).resolves.toBe("const proxied = true;");
        expect(deletedGateways).toContain("gateway-id");
        expect(deletedGateways).toContain("secondary-gateway-id");
        expect(readCleanupRecords()).toEqual([]);
    });
});
