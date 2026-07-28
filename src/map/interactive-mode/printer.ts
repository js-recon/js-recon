import { Widgets } from "blessed";
import { highlight } from "cli-highlight";
import fs from "fs";

/**
 * Print function code with syntax highlighting.
 * @param {Widgets.Log} outputBox - The output box element
 * @param {string} funcCode - The function code to print
 * @param {string} funcDesc - The function description
 * @param {fs.PathOrFileDescriptor} funcWriteFile - The file to write the function code to
 */
const printFunction = (
    outputBox: Widgets.Log,
    funcCode: string,
    funcDesc: string,
    funcWriteFile: fs.PathOrFileDescriptor
) => {
    const rawText = `/**\n* ${funcDesc}\n*/\n${funcCode}`;
    const highlighted = highlight(rawText, {
        language: "javascript",
        ignoreIllegals: true,
        theme: undefined, // This makes cli-highlight use ANSI colors
    });

    outputBox.setContent(highlighted); // << use setContent instead of setText

    if (funcWriteFile !== undefined && funcWriteFile !== null) {
        fs.writeFileSync(funcWriteFile, rawText); // Save raw (non-colored) version to file
    }
};

export { printFunction };
