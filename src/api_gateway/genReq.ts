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
import fs from "fs";
import md5 from "md5";
import * as globals from "../utility/globals.js";
import checkFireWallBlocking from "./checkFireWallBlocking.js";
import { printMsg, MSG } from "../utility/printMsg.js";

/**
 * Utility function to pause execution for a specified duration.
 *
 * @param ms - Number of milliseconds to sleep
 * @returns Promise that resolves after the specified delay
 */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Given a URL, generates a new API Gateway for it and returns the response of the URL.
 * @param {string} url The URL to generate an API Gateway for.
 * @param {object} [headers] The headers to include in the request.
 * @returns {Promise<string>} The response of the URL.
 */
const get = async (url: string, headers: {} = {}): Promise<string> => {
    // read the config file
    // Load and parse API Gateway config with error handling
    let config;
    try {
        config = JSON.parse(fs.readFileSync(globals.apiGatewayConfigFile, "utf8"));
    } catch (error) {
        throw new Error(`Failed to read or parse API Gateway config file: ${error.message}`);
    }
    // select a random api gateway
    let apiGateway = Object.keys(config)[Math.floor(Math.random() * Object.keys(config).length)];

    const client = new APIGatewayClient({
        region: config[apiGateway].region,
        credentials: {
            accessKeyId: config[apiGateway].access_key,
            secretAccessKey: config[apiGateway].secret_key,
        },
    });

    // get the root resource id
    const getResourceCommand = new GetResourcesCommand({
        restApiId: config[apiGateway].id,
        limit: 999999999,
    });
    const getResourceResponse = await client.send(getResourceCommand);
    await sleep(200);

    // before creating a resource, check if the resource already exists
    const resourceExists = getResourceResponse.items.find(
        // file deepcode ignore InsecureHash: False positive
        (item) => item.pathPart === md5(url)
    );

    let newResourceResponse;
    if (resourceExists) {
        // console.error(chalk.yellow("[!] Resource already exists"));
        newResourceResponse = {
            id: resourceExists.id,
        };
    } else {
        // create a new resource
        let rootId;
        if (getResourceResponse.items.find((item) => item.path === "/")) {
            rootId = getResourceResponse.items.find((item) => item.path === "/").id;
        } else {
            rootId = getResourceResponse.items[0].parentId;
        }
        const newResourceCommand = new CreateResourceCommand({
            restApiId: config[apiGateway].id,
            parentId: rootId,
            pathPart: md5(url), // md5 of the url
        });
        newResourceResponse = await client.send(newResourceCommand);
        await sleep(200);

        // add a new method
        const newMethodCommand = new PutMethodCommand({
            restApiId: config[apiGateway].id,
            resourceId: newResourceResponse.id,
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
        });
        const newMethodResponse = await client.send(newMethodCommand);
        await sleep(100);

        // create new integration
        const newIntegrationCommand = new PutIntegrationCommand({
            restApiId: config[apiGateway].id,
            resourceId: newResourceResponse.id,
            httpMethod: "GET",
            integrationHttpMethod: "GET",
            type: "HTTP",
            timeoutInMillis: 29000,
            uri: url,
        });
        const newIntegrationResponse = await client.send(newIntegrationCommand);
        await sleep(100);

        // create a new method response
        const newMethodResponseCommand = new PutMethodResponseCommand({
            httpMethod: "GET",
            resourceId: newResourceResponse.id,
            restApiId: config[apiGateway].id,
            statusCode: "200",
        });
        const newMethodResponseResponse = await client.send(newMethodResponseCommand);
        await sleep(100);

        // put integration response
        const putIntegrationResponseCommand = new PutIntegrationResponseCommand({
            httpMethod: "GET",
            resourceId: newResourceResponse.id,
            restApiId: config[apiGateway].id,
            statusCode: "200",
        });
        const putIntegrationResponseResponse = await client.send(putIntegrationResponseCommand);
        await sleep(100);
    }

    // Generate dynamic stage name
    //   const dynamicStageName = `prod-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    //   console.log(chalk.blue(`[*] Using dynamic stage name: ${dynamicStageName}`));

    // Create a deployment
    //   const createDeploymentCommand = new CreateDeploymentCommand({
    //     restApiId: config[apiGateway].id,
    //     stageName: dynamicStageName,
    //     description: `Deployment for ${url} at ${new Date().toISOString()} to stage ${dynamicStageName}`,
    //   });
    //   const deploymentResponse = await client.send(createDeploymentCommand);
    //   console.log(chalk.green("[+] Deployment created:"), deploymentResponse.id);
    //   await sleep(100);

    const testInvokeMethodQuery = new TestInvokeMethodCommand({
        httpMethod: "GET",
        resourceId: newResourceResponse.id,
        restApiId: config[apiGateway].id,
        headers: headers || {},
    });
    const testInvokeMethodResponse = await client.send(testInvokeMethodQuery);
    await sleep(100);

    const body = await testInvokeMethodResponse.body;

    // check if any firewall is there in the way
    const isFireWallBlocking = await checkFireWallBlocking(body);

    // delete the resource
    const deleteResourceCommand = new DeleteResourceCommand({
        restApiId: config[apiGateway].id,
        resourceId: newResourceResponse.id,
    });
    try {
        await client.send(deleteResourceCommand);
    } catch (err) {
        printMsg(MSG.Err, `[!] Error when sending delete resource command to AWS: ${err}`);
    }

    if (isFireWallBlocking) {
        printMsg(MSG.Err, "[!] Please try again without API Gateway");
        process.exit(18);
    }

    return body;

    // create a new stage
    //   dynamicStageName = `prod-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    //   const newStageCommand = new CreateStageCommand({
    //     restApiId: config[apiGateway].id,
    //     stageName: dynamicStageName, // Use dynamic stage name
    //     deploymentId: deploymentResponse.id, // Use the ID from the deployment
    //     cacheClusterEnabled: false,
    //     // cacheClusterSize: "0", // Removed as cacheClusterEnabled is false
    //     methodSettings: [
    //       {
    //         httpMethod: "*",
    //         // resourceId: "*", // This might need to be more specific if you don't want it for all resources
    //         throttlingBurstLimit: 5,
    //         throttlingRateLimit: 10,
    //       },
    //     ],
    //   });
    //   const newStageResponse = await client.send(newStageCommand);
    //   await sleep(100);
    //   console.log(newStageResponse);
};

export { get };
