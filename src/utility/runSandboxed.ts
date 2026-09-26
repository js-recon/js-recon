import "ses";

// Lock down the global environment for security
lockdown();

/**
 * Executes a given function in a sandboxed environment.
 * @param {string} code - The code to execute.
 * @param {any} param - The parameter to pass to the function.
 * @returns {any} The result of the function execution.
 */
/**
 * Executes a given function in a sandboxed environment.
 *
 * This function takes a string of code that represents a function, and
 * executes it in a sandboxed environment. It also takes a parameter
 * that is passed to the function when it is executed.
 *
 * The sandboxed environment is created using the vm module's
 * Compartment class. This class is used to create a new global
 * environment that is isolated from the current global environment.
 *
 * The function that is passed as a string is wrapped in a self-invoking
 * anonymous function, and then evaluated in the sandboxed environment.
 * The parameter that is passed to the function is then passed to the evaluated
 * function, and the result of the function execution is returned.
 *
 * @param {string} code - The code to execute. This should represent a function.
 * @param {any} param - The parameter to pass to the function.
 * @returns {any} The result of the function execution.
 */
const execFunc = (code, param) => {
    const c = new Compartment({
        console,
    });
    const wrappedCode = `
    (${code})
  `;
    const func = c.evaluate(wrappedCode);
    const output = func(param);

    // Async chunk builders return a Promise that usually rejects because they rely
    // on outer webpack runtime state. Contain the rejection so it can't surface as
    // an unhandled rejection (exit 34), and return undefined — callers only use strings.
    if (typeof output?.then === "function") {
        Promise.resolve(output).catch(() => {});
        return undefined;
    }

    return output;
};

export default execFunc;
