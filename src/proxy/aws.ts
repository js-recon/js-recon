import { APIGatewayClient, CreateRestApiCommand, DeleteRestApiCommand } from "@aws-sdk/client-api-gateway";
import { printMsg, MSG } from "../utility/printMsg.js";
import checkFeasibility from "./checkFeasibility.js";
import { readAwsGatewayMap, writeAwsGatewayMap } from "./awsConfig.js";
import { setActiveProxyMethod } from "./configFile.js";

// read the docs for all the methods for api gateway at https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/api-gateway/
// for the rate limits, refer to https://docs.aws.amazon.com/apigateway/latest/developerguide/limits.html

/**
 * Selects a random AWS region from the available API Gateway regions.
 *
 * @returns A randomly selected AWS region identifier
 */
const randomRegion = (): string => {
    const apiGatewayRegions = [
        "us-east-2", // US East (Ohio)
        "us-east-1", // US East (N. Virginia)
        "us-west-1", // US West (N. California)
        "us-west-2", // US West (Oregon)
        "af-south-1", // Africa (Cape Town)
        "ap-east-1", // Asia Pacific (Hong Kong)
        "ap-south-2", // Asia Pacific (Hyderabad)
        "ap-southeast-3", // Asia Pacific (Jakarta)
        "ap-southeast-5", // Asia Pacific (Malaysia)
        "ap-southeast-4", // Asia Pacific (Melbourne)
        "ap-south-1", // Asia Pacific (Mumbai)
        "ap-northeast-3", // Asia Pacific (Osaka)
        "ap-northeast-2", // Asia Pacific (Seoul)
        "ap-southeast-1", // Asia Pacific (Singapore)
        "ap-southeast-2", // Asia Pacific (Sydney)
        "ap-east-2", // Asia Pacific (Taipei)
        "ap-southeast-7", // Asia Pacific (Thailand)
        "ap-northeast-1", // Asia Pacific (Tokyo)
        "ca-central-1", // Canada (Central)
        "ca-west-1", // Canada West (Calgary)
        "eu-central-1", // Europe (Frankfurt)
        "eu-west-1", // Europe (Ireland)
        "eu-west-2", // Europe (London)
        "eu-south-1", // Europe (Milan)
        "eu-west-3", // Europe (Paris)
        "eu-south-2", // Europe (Spain)
        "eu-north-1", // Europe (Stockholm)
        "eu-central-2", // Europe (Zurich)
        "il-central-1", // Israel (Tel Aviv)
        "mx-central-1", // Mexico (Central)
        "me-south-1", // Middle East (Bahrain)
        "me-central-1", // Middle East (UAE)
        "sa-east-1", // South America (São Paulo)
    ];
    return apiGatewayRegions[Math.floor(Math.random() * apiGatewayRegions.length)];
};

let aws_access_key: string;
let aws_secret_key: string;
let region: string;
let configFile = "";

/**
 * Utility function to pause execution for a specified duration.
 *
 * @param ms - Number of milliseconds to sleep
 * @returns Promise that resolves after the specified delay
 */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Masks a credential for secure display by showing only the first and last 4 characters. */
const keyMask = (key: string): string => {
    if (key.length < 6) return key;
    return key.slice(0, 4) + "..." + key.slice(-4);
};

/**
 * Create a new API Gateway.
 *
 * @async
 * @returns {Promise<void>}
 */
const createGateway = async () => {
    printMsg(MSG.Header, "[i] Creating API Gateway");
    const client = new APIGatewayClient({
        region,
        credentials: {
            accessKeyId: aws_access_key,
            secretAccessKey: aws_secret_key,
        },
    });

    const apigw_created_at = Date.now();
    const apigw_name = `js_recon-${apigw_created_at}-${Math.floor(Math.random() * 1000)}`;
    const command = new CreateRestApiCommand({
        name: apigw_name,
        description: `API Gateway for JS Recon created at ${new Intl.DateTimeFormat("en-US", {
            year: "numeric",
            month: "long",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            timeZoneName: "short",
        }).format(apigw_created_at)}`,
        endpointConfiguration: {
            ipAddressType: "dualstack",
            types: ["REGIONAL"],
        },
    });
    const response = await client.send(command);
    await sleep(3000);
    printMsg(MSG.Run, `[✓] Created API Gateway`);
    printMsg(MSG.Run, `ID: ${response.id}`);
    printMsg(MSG.Run, `Name: ${apigw_name}`);
    printMsg(MSG.Run, `Region: ${region}`);

    const config = readAwsGatewayMap(configFile);

    config[apigw_name] = {
        id: response.id,
        name: apigw_name,
        description: response.description,
        created_at: apigw_created_at,
        region: region,
        access_key: aws_access_key,
        secret_key: aws_secret_key,
    };

    writeAwsGatewayMap(configFile, config);
    setActiveProxyMethod(configFile, "aws");
    printMsg(MSG.Run, `[✓] Config saved to ${configFile}`);
};

/**
 * Destroy an API Gateway.
 *
 * @async
 * @param {string} id - The ID of the API Gateway to destroy.
 * @returns {Promise<void>}
 */
const destroyGateway = async (id: string): Promise<void> => {
    printMsg(MSG.Header, "[i] Destroying API Gateway");
    if (!id) {
        printMsg(MSG.Err, "[!] Please provide an API Gateway ID");
        return;
    }
    const config = readAwsGatewayMap(configFile);
    const name = Object.keys(config).find((key) => config[key].id === id);

    printMsg(MSG.Run, `Name: ${name}`);
    printMsg(MSG.Run, `ID: ${id}`);
    printMsg(MSG.Run, `Region: ${config[name].region}`);
    region = config[name].region;

    const client = new APIGatewayClient({
        region,
        credentials: {
            accessKeyId: aws_access_key,
            secretAccessKey: aws_secret_key,
        },
    });

    const command = new DeleteRestApiCommand({
        restApiId: id,
    });
    await client.send(command);

    delete config[name];
    writeAwsGatewayMap(configFile, config);

    await sleep(30000);

    printMsg(MSG.Run, `[✓] Destroyed API Gateway: ${id}`);
};

/**
 * Destroy all API Gateways.
 *
 * @async
 * @returns {Promise<void>}
 */
const destroyAllGateways = async () => {
    printMsg(MSG.Header, "[i] Destroying all API Gateways");
    const config = readAwsGatewayMap(configFile);

    for (const [key, value] of Object.entries(config)) {
        const client = new APIGatewayClient({
            region: value.region,
            credentials: {
                accessKeyId: aws_access_key,
                secretAccessKey: aws_secret_key,
            },
        });
        printMsg(MSG.Header, `[i] Destroying API Gateway: ${key} : ${value.id} : ${value.region}`);

        const command = new DeleteRestApiCommand({
            restApiId: value.id,
        });
        await sleep(30000);
        await client.send(command);
        printMsg(MSG.Run, `[✓] Destroyed API Gateway: ${key} : ${value.id} : ${value.region}`);
    }

    writeAwsGatewayMap(configFile, {});
    printMsg(MSG.Run, "[✓] Destroyed all API Gateways");
};

/**
 * List all API Gateways.
 *
 * @async
 * @returns {Promise<void>}
 */
const listGateways = async () => {
    printMsg(MSG.Header, "[i] Listing all API Gateways");

    const config = readAwsGatewayMap(configFile);

    if (Object.keys(config).length === 0) {
        printMsg(MSG.Err, "[!] No API Gateways found");
        return;
    }

    printMsg(MSG.Run, "[✓] List of API Gateways");

    for (const [key, value] of Object.entries(config)) {
        printMsg(MSG.Run, `Name: ${key}`);
        printMsg(MSG.Run, `ID: ${value.id}`);
        printMsg(MSG.Run, `Region: ${value.region}`);
        printMsg(MSG.Plain, "\n");
    }
};

export interface ProxyAwsOptions {
    init: boolean;
    destroy?: string;
    destroyAll: boolean;
    list: boolean;
    region?: string;
    accessKey?: string;
    secretKey?: string;
    config: string;
    feasibility: boolean;
    feasibilityUrl?: string;
}

/**
 * Entry point for `proxy aws`: create/destroy/list AWS API Gateways for IP rotation, or check
 * feasibility of routing a target through API Gateway.
 *
 * @async
 * @param opts - Resolved CLI options for the `proxy aws` subcommand.
 * @returns {Promise<void>}
 */
const proxyAws = async (opts: ProxyAwsOptions): Promise<void> => {
    configFile = opts.config || ".proxy_config.json";

    if (opts.feasibility) {
        if (!opts.feasibilityUrl) {
            printMsg(MSG.Err, "[!] Please provide a URL to check feasibility of");
            return;
        }
        await checkFeasibility(opts.feasibilityUrl);
        return;
    }

    if (!opts.init && !opts.destroy && !opts.destroyAll && !opts.list) {
        printMsg(MSG.Err, "[!] Please provide a valid action (-i/--init, -d/--destroy, --destroy-all, or -l/--list)");
        return;
    }

    aws_access_key = opts.accessKey || process.env.AWS_ACCESS_KEY_ID || undefined;
    aws_secret_key = opts.secretKey || process.env.AWS_SECRET_ACCESS_KEY || undefined;
    region = opts.region || randomRegion();

    if (!aws_access_key || !aws_secret_key) {
        printMsg(MSG.Err, "[!] AWS Access Key or Secret Key not found. Run with -h to see help");
        process.exit(1);
    }

    printMsg(MSG.Header, `[i] Using region: ${region}`);
    printMsg(MSG.Header, `[i] Using access key: ${keyMask(aws_access_key)}`);

    if (opts.init) {
        await createGateway();
    } else if (opts.destroy) {
        await destroyGateway(opts.destroy);
    } else if (opts.destroyAll) {
        await destroyAllGateways();
    } else {
        await listGateways();
    }
};

export default proxyAws;
