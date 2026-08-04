import blessed from "blessed";

/**
 * Create the UI elements.
 * @returns {{
 *   screen: blessed.Widgets.Screen,
 *   titleBox: blessed.Widgets.BoxElement,
 *   outputBox: blessed.Widgets.Log,
 *   inputBox: blessed.Widgets.TextboxElement,
 * }} Object containing the screen and its associated boxes
 */
function createUI() {
    // Create a screen object.
    const screen = blessed.screen({
        smartCSR: true,
        title: "JS Recon Interactive Mode",
        fullUnicode: true,
    });

    // Title Box
    const titleBox = blessed.box({
        parent: screen,
        top: 0,
        left: "center",
        width: "98%",
        height: 3,
        content: "JS Recon Interactive Mode",
        border: {
            type: "line",
        },
        style: {
            fg: "white",
            border: {
                fg: "gray",
            },
        },
    });

    // Output Box
    const outputBox = blessed.log({
        parent: screen,
        top: 3,
        left: "center",
        width: "98%",
        bottom: 3,
        border: {
            type: "line",
        },
        style: {
            fg: "white",
            border: {
                fg: "gray",
            },
        },
        scrollable: true,
        alwaysScroll: true,
        scrollbar: {
            ch: " ",
        },
        keys: true,
        vi: true,
        scrollSpeed: 0.5,
    });

    // Input Box
    const inputBox = blessed.textbox({
        parent: screen,
        bottom: 0,
        left: "center",
        width: "98%",
        height: 3,
        border: {
            type: "line",
        },
        style: {
            fg: "white",
            bg: "black",
            border: {
                fg: "gray",
            },
            focus: {
                border: {
                    fg: "blue",
                },
            },
        },
        inputOnFocus: true,
    });

    return { screen, titleBox, outputBox, inputBox };
}

export { createUI };
