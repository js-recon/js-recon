import { get } from "./genReq.js";
import checkFireWallBlocking from "./checkFireWallBlocking.js";
import { printMsg, MSG } from "../utility/printMsg.js";

/**
 * Checks the feasibility of using API Gateway by testing for firewall blocking.
 *
 * Sends multiple test requests to the target URL through the API Gateway
 * to determine if the requests are being blocked by a firewall or security system.
 *
 * @param url - The target URL to test for API Gateway feasibility
 * @returns Promise that resolves when feasibility check is complete
 */
const checkFeasibility = async (url: string): Promise<void> => {
    printMsg(MSG.Header, `[i] Checking feasibility of API Gateway with ${url}`);
    try {
        // send 10 requests, and check if any of those contain any signs of blocking
        for (let i = 0; i < 10; i++) {
            const response = await get(url);
            const isFireWallBlocking = await checkFireWallBlocking(response);
            if (isFireWallBlocking) {
                printMsg(MSG.Err, "[!] Please try again without API Gateway");
                return;
            }
        }
        printMsg(
            MSG.Run,
            `[✓] Feasibility check passed. However, this doesn't represent the true nature of the firewall used.`
        );
    } catch (error) {
        printMsg(MSG.Err, `[!] An error occured in feasibility check: ${error}`);
    }
};

export default checkFeasibility;
