const githubURL = "https://github.com/js-recon/js-recon";
const modulesDocs = "https://js-recon.io/docs/category/modules";
const version = "2.0.1";
const toolDesc = "JavaScript Enumeration and SAST";
const axiosNonHttpMethods = ["isAxiosError"]; // methods available in axios, which are not for making HTTP requests

let CONFIG = {
    github: githubURL,
    modulesDocs: modulesDocs,
    notFoundMessage: `If you believe this is an error or is a new technology, please create an issue on ${githubURL} and we'll figure it out for you`,
    version: version,
    toolDesc: toolDesc,
    axiosNonHttpMethods: axiosNonHttpMethods,
    issueUrl: `${githubURL}/issues/new/choose`,
};

export default CONFIG;
