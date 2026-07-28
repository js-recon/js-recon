import { printMsg, MSG } from "../utility/printMsg.js";
import { readProxyConfigFile, writeProxyConfigFile } from "./configFile.js";

/** Shape of a single AWS gateway entry in the config's `aws` map. */
export interface AwsGatewayEntry {
    id: string;
    name: string;
    description: string;
    created_at: number;
    region: string;
    access_key: string;
    secret_key: string;
}

let legacyWarningShown = false;

const looksLikeLegacyGatewayMap = (value: unknown): value is Record<string, AwsGatewayEntry> => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }
    const entries = Object.values(value as Record<string, unknown>);
    if (entries.length === 0) {
        return false;
    }
    return entries.every(
        (entry) =>
            typeof entry === "object" &&
            entry !== null &&
            "id" in entry &&
            "region" in entry &&
            "access_key" in entry &&
            "secret_key" in entry
    );
};

/**
 * Reads the `aws` gateway map from `.proxy_config.json`, falling back to treating the
 * whole file as a legacy `.api_gateway_config.json`-shaped flat map when no `aws` key
 * is present but the top-level values match that shape.
 */
export const readAwsGatewayMap = (configFile: string): Record<string, AwsGatewayEntry> => {
    const full = readProxyConfigFile(configFile);
    if (full.aws && typeof full.aws === "object") {
        return full.aws as Record<string, AwsGatewayEntry>;
    }
    if (looksLikeLegacyGatewayMap(full)) {
        if (!legacyWarningShown) {
            printMsg(
                MSG.Warn,
                `[!] ${configFile} is in the legacy .api_gateway_config.json format. It will be migrated to the new { "aws": {...} } shape on the next gateway create/destroy.`
            );
            legacyWarningShown = true;
        }
        return full as unknown as Record<string, AwsGatewayEntry>;
    }
    return {};
};

/** Persists the `aws` gateway map, preserving any other proxy-method keys already in the file. */
export const writeAwsGatewayMap = (configFile: string, awsMap: Record<string, AwsGatewayEntry>): void => {
    const existing = readProxyConfigFile(configFile);
    const full = looksLikeLegacyGatewayMap(existing) && !existing.aws ? {} : existing;
    full.aws = awsMap;
    writeProxyConfigFile(configFile, full);
};
