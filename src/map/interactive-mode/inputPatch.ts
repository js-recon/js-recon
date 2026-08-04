import { Widgets } from "blessed";

/**
 * Enable standard line-editor behavior on a blessed textbox: cursor movement
 * (left/right/home/end/ctrl-a/ctrl-e), word-wise delete (ctrl-w), kill-to-end
 * (ctrl-k), kill-to-start (ctrl-u), delete-at-cursor, mid-string insertion
 * (so paste lands where the cursor is), and horizontal scroll when the value
 * is longer than the visible width.
 *
 * Implementation notes: blessed's Textarea installs a keypress listener on
 * every focus by binding `this._listener` and storing it as `this.__listener`.
 * Removing that listener after the fact races with re-installation, so we
 * instead override `_listener` itself on the instance — blessed then binds
 * *our* function as its handler and only one listener is ever attached.
 */
export function enableCursorInput(inputBox: Widgets.TextboxElement): void {
    const box: any = inputBox as any;

    box.cursorPos = box.value ? box.value.length : 0;
    box.scrollOffset = 0;

    const updateDisplay = () => {
        const width = Math.max(1, (box.width as number) - box.iwidth - 1);
        if (box.cursorPos < box.scrollOffset) {
            box.scrollOffset = box.cursorPos;
        } else if (box.cursorPos > box.scrollOffset + width) {
            box.scrollOffset = box.cursorPos - width;
        }
        const visible = box.value.slice(box.scrollOffset, box.scrollOffset + width + 1);
        box.setContent(visible.replace(/\t/g, box.screen.tabc));
    };

    box.setValue = function (value: string | null) {
        if (value == null) value = box.value;
        value = value.replace(/\n/g, "");
        if (box._value !== value) {
            box.value = value;
            box._value = value;
            box.cursorPos = value.length;
            box.scrollOffset = 0;
            updateDisplay();
            box._updateCursor();
        }
    };

    box.clearValue = box.clearInput = function () {
        box.cursorPos = 0;
        box.scrollOffset = 0;
        box.value = "";
        box._value = "";
        box.setContent("");
        box._updateCursor();
    };

    box._updateCursor = function () {
        if (box.screen.focused !== box) return;
        const lpos = box._getCoords();
        if (!lpos) return;
        const col = box.cursorPos - box.scrollOffset;
        const cx = lpos.xi + box.ileft + Math.max(0, col);
        const cy = lpos.yi + box.itop;
        const program = box.screen.program;
        if (cy === program.y && cx === program.x) return;
        if (cy === program.y) {
            if (cx > program.x) program.cuf(cx - program.x);
            else if (cx < program.x) program.cub(program.x - cx);
        } else if (cx === program.x) {
            if (cy > program.y) program.cud(cy - program.y);
            else if (cy < program.y) program.cuu(program.y - cy);
        } else {
            program.cup(cy, cx);
        }
    };

    // Replace the instance's _listener. blessed's readInput() will bind this
    // and attach it as __listener — so we end up as the sole keypress handler.
    box._listener = function (ch: string | undefined, key: any) {
        const k = key && key.name;

        if (k === "enter" || k === "return") {
            box._done(null, box.value);
            return;
        }
        if (k === "escape") {
            box._done(null, null);
            return;
        }

        // Up/down are owned by the history-navigation keybindings.
        if (k === "up" || k === "down") return;

        if (k === "left") {
            if (key.ctrl) {
                let p = box.cursorPos;
                while (p > 0 && /\s/.test(box.value[p - 1])) p--;
                while (p > 0 && !/\s/.test(box.value[p - 1])) p--;
                box.cursorPos = p;
            } else if (box.cursorPos > 0) {
                box.cursorPos--;
            }
            updateDisplay();
            box._updateCursor();
            box.screen.render();
            return;
        }
        if (k === "right") {
            if (key.ctrl) {
                let p = box.cursorPos;
                while (p < box.value.length && /\s/.test(box.value[p])) p++;
                while (p < box.value.length && !/\s/.test(box.value[p])) p++;
                box.cursorPos = p;
            } else if (box.cursorPos < box.value.length) {
                box.cursorPos++;
            }
            updateDisplay();
            box._updateCursor();
            box.screen.render();
            return;
        }
        if (k === "home" || (key && key.ctrl && k === "a")) {
            box.cursorPos = 0;
            updateDisplay();
            box._updateCursor();
            box.screen.render();
            return;
        }
        if (k === "end" || (key && key.ctrl && k === "e")) {
            box.cursorPos = box.value.length;
            updateDisplay();
            box._updateCursor();
            box.screen.render();
            return;
        }

        if (k === "backspace") {
            if (box.cursorPos > 0) {
                box.value = box.value.slice(0, box.cursorPos - 1) + box.value.slice(box.cursorPos);
                box.cursorPos--;
                box._value = box.value;
                updateDisplay();
                box._updateCursor();
                box.screen.render();
            }
            return;
        }
        if (k === "delete") {
            if (box.cursorPos < box.value.length) {
                box.value = box.value.slice(0, box.cursorPos) + box.value.slice(box.cursorPos + 1);
                box._value = box.value;
                updateDisplay();
                box._updateCursor();
                box.screen.render();
            }
            return;
        }
        if (key && key.ctrl && k === "u") {
            box.value = box.value.slice(box.cursorPos);
            box.cursorPos = 0;
            box._value = box.value;
            updateDisplay();
            box._updateCursor();
            box.screen.render();
            return;
        }
        if (key && key.ctrl && k === "k") {
            box.value = box.value.slice(0, box.cursorPos);
            box._value = box.value;
            updateDisplay();
            box._updateCursor();
            box.screen.render();
            return;
        }
        if (key && key.ctrl && k === "w") {
            let p = box.cursorPos;
            while (p > 0 && /\s/.test(box.value[p - 1])) p--;
            while (p > 0 && !/\s/.test(box.value[p - 1])) p--;
            box.value = box.value.slice(0, p) + box.value.slice(box.cursorPos);
            box.cursorPos = p;
            box._value = box.value;
            updateDisplay();
            box._updateCursor();
            box.screen.render();
            return;
        }

        // ctrl-c is handled by an outer keybinding.
        if (key && key.ctrl) return;

        // Printable char (paste arrives as a burst of single-char events).
        if (ch && !/^[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]$/.test(ch)) {
            box.value = box.value.slice(0, box.cursorPos) + ch + box.value.slice(box.cursorPos);
            box.cursorPos += ch.length;
            box._value = box.value;
            updateDisplay();
            box._updateCursor();
            box.screen.render();
        }
    };
}
