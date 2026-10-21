import vue_resolveFetch from "../vue_js/vue_resolveFetch.js";

const react_resolveFetch = (directory: string): Promise<void> => {
    return vue_resolveFetch(directory, "React");
};

export default react_resolveFetch;
