import { APIGatewayClient, CreateRestApiCommand, DeleteRestApiCommand } from "@aws-sdk/client-api-gateway";
import fs from "fs";
import checkFeasibility from "./checkFeasibility.js";
import { printMsg, MSG } from "../utility/printMsg.js";

// read the docs for all the methods for api gateway at https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/api-gateway/
// for the rate limits, refer to https://docs.aws.amazon.com/apigateway/latest/developerguide/limits.html

interface ApiGatewayConfig {
    (key: string): {
        id: string;
        name: string;
        description: string;
        created_at: number;
        region: string;
        access_key: string;
        secret_key: string;
    };
}

/**
 * Selects a random AWS region from the available API Gateway regions.
 *
 * @returns A randomly selected AWS region identifier
 */
const randomRegion = (): string => {
    const apiGatewayRegions = [
        "us-east-2", // US East (Ohio)
        "us-east-1", // US East (N. Virginia)
        "us-west-1", // US West (N. California)
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
        "il-central-1", // Israel (Tel Aviv)
        "mx-central-1", // Mexico (Central)
        "me-south-1", // Middle East (Bahrain)
        "me-central-1", // Middle East (UAE)
        "sa-east-1", // South America (São Paulo)
    ];
    return apiGatewayRegions[Math.floor(Math.random() * apiGatewayRegions.length)];
};

let aws_access_key;
let aws_secret_key;
let region;
let configFile = "";

/**
 * Utility function to pause execution for a specified duration.
 *
 * @param ms - Number of milliseconds to sleep
 * @returns Promise that resolves after the specified delay
 */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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

    // load the config file if any. Else, create a new one
    let config = {};
    try {
        config = JSON.parse(fs.readFileSync(configFile, "utf8"));
    } catch (e) {
        config = {};
    }

    config[apigw_name] = {
        id: response.id,
        name: apigw_name,
        description: response.description,
        created_at: apigw_created_at,
        region: region,
        access_key: aws_access_key,
        secret_key: aws_secret_key,
    };

    fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
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
    //   read the config file
    let config = JSON.parse(fs.readFileSync(configFile, "utf8"));
    //   get the name of the api gateway
    let name = Object.keys(config).find((key) => config[key].id === id);

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

    // remove from the config file
    delete config[name];
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2));

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
    //   read the config file
    let config: ApiGatewayConfig = JSON.parse(fs.readFileSync(configFile, "utf8"));

    //   destroy all the gateways
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

    // nullify the config file
    fs.writeFileSync(configFile, JSON.stringify({}, null, 2));
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

    // read the config file, and list these

    // check if the config file exists
    if (!fs.existsSync(configFile)) {
        printMsg(MSG.Err, "[!] Config file does not exist");
        return;
    }

    const config: ApiGatewayConfig = JSON.parse(fs.readFileSync(configFile, "utf8"));

    //   if list is empty
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

/**
 * Main function for API Gateway.
 *
 * @async
 * @param {boolean} initInput - Whether to initialize the API Gateway.
 * @param {string} destroyInput - The ID of the API Gateway to destroy.
 * @param {boolean} destroyAllInput - Whether to destroy all API Gateways.
 * @param {boolean} listInput - Whether to list all API Gateways.
 * @param {string} regionInput - The region to use.
 * @param {string} accessKey - The access key to use.
 * @param {string} secretKey - The secret key to use.
 * @param {string} configInput - The config file to use.
 * @param {boolean} feasibilityInput - Whether to check feasibility.
 * @param {string} feasibilityUrlInput - The URL to check feasibility for.
 * @returns {Promise<void>}
 */
const apiGateway = async (
    initInput: boolean,
    destroyInput: string,
    destroyAllInput: boolean,
    listInput: boolean,
    regionInput: string,
    accessKey: string,
    secretKey: string,
    configInput: string,
    feasibilityInput: boolean,
    feasibilityUrlInput: string
): Promise<void> => {
    printMsg(MSG.Header, "[i] Loading 'API Gateway' module");

    // if feasibility is true, check feasibility
    if (feasibilityInput) {
        if (!feasibilityUrlInput) {
            printMsg(MSG.Err, "[!] Please provide a URL to check feasibility of");
            return;
        }
        await checkFeasibility(feasibilityUrlInput);
        return;
    }

    // configure the access and secret key
    aws_access_key = accessKey || process.env.AWS_ACCESS_KEY_ID || undefined;
    aws_secret_key = secretKey || process.env.AWS_SECRET_ACCESS_KEY || undefined;
    region = regionInput || randomRegion();
    configFile = configInput || "config.json";

    if (!aws_access_key || !aws_secret_key) {
        printMsg(MSG.Err, "[!] AWS Access Key or Secret Key not found. Run with -h to see help");
        return;
    }

    printMsg(MSG.Header, `[i] Using region: ${region}`);

    /**
     * Masks an API key for secure display by showing only first and last 4 characters.
     *
     * @param key - The API key to mask
     * @returns Masked version of the key
     */
    const keyMask = (key: string): string => {
        if (key.length < 6) return key;
        return key.slice(0, 4) + "..." + key.slice(-4);
    };
    printMsg(MSG.Header, `[i] Using access key: ${keyMask(aws_access_key)}`);

    // create a new API gateway
    if (initInput) {
        await createGateway();
    } else if (destroyInput) {
        await destroyGateway(destroyInput);
    } else if (destroyAllInput) {
        await destroyAllGateways();
    } else if (listInput) {
        await listGateways();
    } else {
        printMsg(MSG.Err, "[!] Please provide a valid action (-i/--init or -d/--destroy or --destroy-all)");
    }
};

export default apiGateway;
