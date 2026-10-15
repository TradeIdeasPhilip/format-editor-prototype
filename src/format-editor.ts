// MARK: Format Editor

import {
  formatInEffect,
  isFormat,
  parse,
  pushContent,
  serialize,
  Unit,
} from "./format-string.ts";

/**
 * A `contenteditable` element containing a mix of plain text and "chips".
 * Each chip is a format marker, displayed as a `<select>`.
 *
 * **Who does what:**
 * * Ordinary typing and deleting are left to the browser.
 *   That keeps spell check, IME, autocorrect, etc. working.
 *   After each `input` event we inspect the DOM and repair anything we don't like.
 * * Everything else (paste, cut, copy, Enter, undo, insert-a-format) is done by us.
 *   We read the DOM into an array of {@link Unit}s, edit the array, and rebuild the DOM.
 *   Selections are saved and restored as *logical offsets*:
 *   each character counts as 1 and each chip counts as 1.
 *
 * **Invariants, restored after every change:**
 * * The top level of {@link element} only contains text nodes, chips, and possibly a trailing {@link SENTINEL_CLASS} `<br>`.
 * * The first unit is always a format.
 * * Content never contains `⸨` or `⸩`.
 *
 * Because we rebuild the DOM ourselves, the browser's built in undo would be confused.
 * So we keep our own undo history and intercept the undo and redo commands.
 */
export class FormatEditor {
  /**
   * The editable area.  Put this wherever you like.
   */
  readonly element = document.createElement("div");

  /**
   * Called after every change to {@link value}, whatever caused it.
   */
  onChange: ((value: string) => void) | undefined;

  #knownNames: readonly string[] = [];
  /**
   * If the user deletes the leading format, we put this one back.
   * Usually this is the name of the format the user just deleted.
   */
  #leadingName: string;
  /**
   * Chips that we created and still trust.
   * Anything else that looks like a chip came from somewhere unexpected, so we rebuild the DOM.
   */
  readonly #chips = new WeakSet<HTMLElement>();
  /**
   * Where the selection was the last time it was inside the editor.
   * Clicking a button elsewhere on the page might clear the real selection.
   */
  #lastSelection: Offsets | undefined;
  readonly #history: Snapshot[] = [];
  #historyIndex = 0;

  /**
   * @param initialValue A string in the `⸨format⸩content` format.
   * @param knownNames The format names that will *not* be drawn in red.
   */
  constructor(initialValue: string, knownNames: readonly string[]) {
    this.#knownNames = knownNames;
    this.#leadingName = knownNames[0] ?? "";
    const element = this.element;
    element.className = "format-editor";
    element.contentEditable = "true";
    element.spellcheck = false;
    element.addEventListener("beforeinput", (event) =>
      this.#onBeforeInput(event),
    );
    element.addEventListener("input", (event) => {
      // A <select> inside a chip also sends input events, and they bubble up to here.
      if (event.target === element) {
        this.#repairDom();
        this.#commit("typing");
      }
    });
    element.addEventListener("keydown", (event) => this.#onKeyDown(event));
    element.addEventListener("copy", (event) => this.#onCopy(event));
    element.addEventListener("cut", (event) => {
      const selection = this.#getSelection();
      if (this.#onCopy(event) && selection) {
        this.#replace(selection, [], "cut");
      }
    });
    element.addEventListener("paste", (event) => {
      event.preventDefault();
      const text = event.clipboardData?.getData("text/plain") ?? "";
      this.#replace(this.#getSelection(), parse(text), "paste");
    });
    // Drag and drop would need its own version of all the cut and paste logic.
    // For a prototype, just turn it off.
    for (const type of ["dragstart", "dragover", "drop"]) {
      element.addEventListener(type, (event) => event.preventDefault());
    }
    document.addEventListener("selectionchange", () => {
      const selection = this.#getSelection();
      if (selection) {
        this.#lastSelection = selection;
      }
    });
    const units = parse(initialValue);
    this.#ensureLeadingFormat(units);
    this.#render(units);
    this.#history.push({
      value: this.value,
      selection: { start: 1, end: 1 },
      kind: "initial",
      time: 0,
    });
  }

  /**
   * The current contents, in the format expected by `MultiTextComponent.addText1()`.
   */
  get value(): string {
    return serialize(this.#units());
  }
  set value(newValue: string) {
    this.#replace({ start: 0, end: this.#units().length }, parse(newValue), "set");
  }

  get knownNames(): readonly string[] {
    return this.#knownNames;
  }
  /**
   * Changing the list of known names immediately updates which chips are red.
   * It does not change {@link value} and it is not recorded in the undo history.
   */
  set knownNames(newValue: readonly string[]) {
    this.#knownNames = [...newValue];
    for (const chip of this.#chipElements()) {
      this.#refreshChip(chip);
    }
  }

  /**
   * Insert a new format at the cursor and open its menu.
   *
   * The new format starts with the same name as the format that was already
   * in effect at the cursor, so the text doesn't change appearance until the user picks something.
   * @param name Use this name instead of the default.
   */
  insertFormat(name?: string) {
    const selection = this.#getSelection() ??
      this.#lastSelection ?? {
        start: this.#units().length,
        end: this.#units().length,
      };
    name ??=
      formatInEffect(this.#units(), selection.start) ?? this.#leadingName;
    this.#replace(selection, [{ format: name }], "insert format");
    // The new chip is immediately before the cursor.
    const cursor = this.#getSelection();
    const chip = cursor && this.#chipElements()[this.#chipIndexBefore(cursor.start)];
    const select = chip?.querySelector("select");
    if (select) {
      select.focus();
      try {
        // Chrome & Firefox allow this during a click.
        select.showPicker();
      } catch {
        // Not supported.  The select still has focus, so the arrow keys work.
      }
    }
  }

  undo() {
    if (this.#historyIndex > 0) {
      this.#historyIndex--;
      this.#restore(this.#history[this.#historyIndex]);
    }
  }

  redo() {
    if (this.#historyIndex < this.#history.length - 1) {
      this.#historyIndex++;
      this.#restore(this.#history[this.#historyIndex]);
    }
  }

  // MARK: Events

  #onBeforeInput(event: InputEvent) {
    const type = event.inputType;
    if (type == "insertParagraph" || type == "insertLineBreak") {
      // Left alone, the browser would add <div> or <br> elements.
      event.preventDefault();
      this.#replace(this.#getSelection(), ["\n"], "typing");
    } else if (type == "historyUndo") {
      event.preventDefault();
      this.undo();
    } else if (type == "historyRedo") {
      event.preventDefault();
      this.redo();
    } else if (type.startsWith("format")) {
      // Ctrl-B, Ctrl-I, etc.  This is not that kind of editor.
      event.preventDefault();
    } else if (type == "insertText" && event.data != null) {
      const selection = this.#getSelection();
      if (selection && selection.start == 0) {
        // The cursor is *before* the leading format.
        // If we let the browser insert the text there, the repair code would have to
        // add another format in front of it.  Let's put the text where the user meant it.
        event.preventDefault();
        this.#replace(selection, pushContent([], event.data), "typing");
      }
    }
  }

  #onKeyDown(event: KeyboardEvent) {
    // Most browsers would report these as historyUndo or historyRedo in beforeinput,
    // but not all of them, and not when the focus is in a chip.
    if (!(event.ctrlKey || event.metaKey) || event.altKey) {
      return;
    }
    const key = event.key.toLowerCase();
    if (key == "z" && !event.shiftKey) {
      event.preventDefault();
      this.undo();
    } else if ((key == "z" && event.shiftKey) || key == "y") {
      event.preventDefault();
      this.redo();
    }
  }

  /**
   * Put the selected units on the clipboard, in the `⸨format⸩content` format.
   * @returns true if there was something to copy.
   */
  #onCopy(event: ClipboardEvent): boolean {
    const range = this.#getRange();
    if (!range || range.collapsed) {
      return false;
    }
    event.preventDefault();
    const units = unitsFromNodes(range.cloneContents());
    event.clipboardData?.setData("text/plain", serialize(units));
    return true;
  }

  // MARK: Model ↔ DOM

  /**
   * Read the current state of the DOM.
   * This works even if the browser has added unexpected elements.
   */
  #units(): Unit[] {
    return unitsFromNodes(this.element);
  }

  /**
   * Replace the entire DOM to match `units`.
   * This does not touch the selection.
   */
  #render(units: readonly Unit[]) {
    const nodes: Node[] = [];
    let pendingText = "";
    const flushText = () => {
      if (pendingText != "") {
        nodes.push(document.createTextNode(pendingText));
        pendingText = "";
      }
    };
    for (const unit of units) {
      if (isFormat(unit)) {
        flushText();
        nodes.push(this.#createChip(unit.format));
      } else {
        pendingText += unit;
      }
    }
    flushText();
    if (units.at(-1) == "\n") {
      nodes.push(createSentinel());
    }
    this.element.replaceChildren(...nodes);
    const first = units[0];
    if (isFormat(first)) {
      this.#leadingName = first.format;
    }
  }

  /**
   * The browser has finished editing the DOM.
   * Fix anything that breaks our invariants, while keeping the cursor in the same logical place.
   */
  #repairDom() {
    const units = this.#units();
    const clean = this.#domIsClean(units);
    const addedLeadingFormat = this.#ensureLeadingFormat(units);
    if (addedLeadingFormat == 0 && clean) {
      const first = units[0];
      if (isFormat(first)) {
        this.#leadingName = first.format;
      }
      return;
    }
    const selection = this.#getSelection();
    this.#render(units);
    if (selection) {
      this.#setSelection({
        start: selection.start + addedLeadingFormat,
        end: selection.end + addedLeadingFormat,
      });
    }
  }

  /**
   * The workhorse for every edit that we do ourselves.
   * Replace part of the contents, put the cursor after the new stuff, and record the change.
   * @param selection What to replace.  If this is undefined, nothing happens.
   * This happens, e.g., if the user pastes while the focus is in a `<select>`.
   * @param inserted What to put in its place.
   * @param kind For the undo history.
   */
  #replace(
    selection: Offsets | undefined,
    inserted: readonly Unit[],
    kind: string,
  ) {
    if (!selection) {
      return;
    }
    let { start, end } = selection;
    const units = this.#units();
    if (start == 0 && end == 0 && units.length > 0 && !isFormat(inserted[0])) {
      // Don't put text in front of the leading format.
      start = end = 1;
    }
    units.splice(start, end - start, ...inserted);
    const cursor = start + inserted.length + this.#ensureLeadingFormat(units);
    this.#render(units);
    this.#setSelection({ start: cursor, end: cursor });
    this.#commit(kind);
  }

  /**
   * Add a format to the front of `units` if it doesn't already start with one.
   * @returns The number of units added, 0 or 1.
   */
  #ensureLeadingFormat(units: Unit[]): number {
    if (isFormat(units[0])) {
      return 0;
    }
    units.unshift({ format: this.#leadingName });
    return 1;
  }

  /**
   * Is the top level DOM exactly what {@link #render} would have created?
   * @param units The current contents, already read from the DOM.
   */
  #domIsClean(units: readonly Unit[]): boolean {
    const children = this.element.childNodes;
    let previousWasText = false;
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      const isText = child instanceof Text;
      if (isText) {
        if (previousWasText || /[⸨⸩\r]/.test(child.data)) {
          return false;
        }
      } else if (child instanceof HTMLElement && this.#chips.has(child)) {
        if (!(child.firstElementChild instanceof HTMLSelectElement)) {
          return false;
        }
      } else if (
        !(child instanceof HTMLElement) ||
        !child.classList.contains(SENTINEL_CLASS) ||
        i != children.length - 1
      ) {
        return false;
      }
      previousWasText = isText;
    }
    const hasSentinel =
      this.element.lastElementChild?.classList.contains(SENTINEL_CLASS) ??
      false;
    return hasSentinel == (units.at(-1) == "\n");
  }

  // MARK: Chips

  #createChip(name: string): HTMLElement {
    const chip = document.createElement("span");
    chip.className = CHIP_CLASS;
    chip.contentEditable = "false";
    chip.dataset.name = name;
    const select = document.createElement("select");
    select.title = "Format";
    select.addEventListener("change", () => {
      chip.dataset.name = select.value;
      this.#refreshChip(chip);
      if (chip === this.element.firstChild) {
        this.#leadingName = select.value;
      }
      // Send the user back to typing, just after this chip.
      this.element.focus();
      const index = this.#chipElements().indexOf(chip);
      this.#setSelection(this.#selectionAfterChip(index));
      this.#commit("change format");
    });
    chip.append(select);
    this.#chips.add(chip);
    this.#refreshChip(chip);
    return chip;
  }

  /**
   * Update the options and the color of a chip to match its name and the list of known names.
   *
   * An unknown name is drawn in red, and it is added at the top of the menu,
   * so the menu can still show the current value.
   * As soon as the user picks a known name, the unknown one disappears.
   */
  #refreshChip(chip: HTMLElement) {
    const select = chip.querySelector("select")!;
    const name = chip.dataset.name ?? "";
    const valid = this.#knownNames.includes(name);
    const options = this.#knownNames.map((known) => createOption(known));
    if (!valid) {
      const option = createOption(name);
      option.classList.add("invalid");
      options.unshift(option);
    }
    select.replaceChildren(...options);
    select.value = name;
    chip.classList.toggle("invalid", !valid);
    chip.title = valid ? "" : `Unknown format: “${name}”`;
  }

  #chipElements(): HTMLElement[] {
    return Array.from(this.element.children).filter(
      (child): child is HTMLElement =>
        child instanceof HTMLElement && this.#chips.has(child),
    );
  }

  /**
   * @returns The index (among chips only) of the last chip before `offset`.
   */
  #chipIndexBefore(offset: number): number {
    return (
      this.#units()
        .slice(0, offset)
        .filter((unit) => isFormat(unit)).length - 1
    );
  }

  #selectionAfterChip(chipIndex: number): Offsets {
    const units = this.#units();
    let seen = -1;
    for (let i = 0; i < units.length; i++) {
      if (isFormat(units[i])) {
        seen++;
        if (seen == chipIndex) {
          return { start: i + 1, end: i + 1 };
        }
      }
    }
    return { start: units.length, end: units.length };
  }

  // MARK: Selection

  /**
   * @returns The DOM selection, but only if it's entirely within the editor.
   */
  #getRange(): Range | undefined {
    const selection = document.getSelection();
    if (!selection || selection.rangeCount == 0) {
      return undefined;
    }
    const range = selection.getRangeAt(0);
    if (
      !this.element.contains(range.startContainer) ||
      !this.element.contains(range.endContainer)
    ) {
      return undefined;
    }
    return range;
  }

  /**
   * @returns The current selection as logical offsets, or undefined if the selection is not in the editor.
   */
  #getSelection(): Offsets | undefined {
    const range = this.#getRange();
    if (!range) {
      return undefined;
    }
    return {
      start: this.#offsetOf(range.startContainer, range.startOffset),
      end: this.#offsetOf(range.endContainer, range.endOffset),
    };
  }

  /**
   * Convert a DOM position into a logical offset.
   *
   * This copies everything from the start of the editor up to the given point, then counts the units.
   * That's not the fastest approach, but it gives exactly the same answer as {@link #units},
   * no matter how messy the DOM is.  A point inside a chip counts as being after that chip.
   */
  #offsetOf(node: Node, offset: number): number {
    const range = document.createRange();
    range.setStart(this.element, 0);
    range.setEnd(node, offset);
    return unitsFromNodes(range.cloneContents()).length;
  }

  /**
   * Convert a logical offset into a DOM position.
   * This assumes that the DOM was just created by {@link #render}.
   */
  #pointAt(offset: number): [Node, number] {
    const children = this.element.childNodes;
    let remaining = offset;
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (child instanceof Text) {
        if (remaining <= child.length) {
          return [child, remaining];
        }
        remaining -= child.length;
      } else if (this.#chips.has(child as HTMLElement)) {
        if (remaining == 0) {
          return [this.element, i];
        }
        remaining--;
      }
    }
    const last = this.element.lastElementChild;
    const end =
      children.length - (last?.classList.contains(SENTINEL_CLASS) ? 1 : 0);
    return [this.element, end];
  }

  #setSelection({ start, end }: Offsets) {
    const selection = document.getSelection();
    if (!selection) {
      return;
    }
    const range = document.createRange();
    range.setStart(...this.#pointAt(start));
    range.setEnd(...this.#pointAt(end));
    selection.removeAllRanges();
    selection.addRange(range);
  }

  // MARK: History

  /**
   * Record the current state for undo, and tell the listener.
   *
   * Consecutive typing is merged into a single undo step,
   * unless the user pauses for a while.
   */
  #commit(kind: string) {
    const value = this.value;
    const selection = this.#getSelection() ?? { start: 0, end: 0 };
    const time = performance.now();
    const top = this.#history[this.#historyIndex];
    if (top.value == value) {
      return;
    }
    this.#history.length = this.#historyIndex + 1;
    const snapshot = { value, selection, kind, time };
    if (
      kind == "typing" &&
      top.kind == "typing" &&
      time - top.time < TYPING_MERGE_MS &&
      this.#historyIndex > 0
    ) {
      this.#history[this.#historyIndex] = snapshot;
    } else {
      this.#history.push(snapshot);
      this.#historyIndex++;
    }
    this.onChange?.(value);
  }

  #restore(snapshot: Snapshot) {
    const units = parse(snapshot.value);
    this.#ensureLeadingFormat(units);
    this.#render(units);
    this.element.focus();
    this.#setSelection(snapshot.selection);
    this.onChange?.(snapshot.value);
  }
}

/**
 * Logical offsets.  See {@link FormatEditor}.
 */
type Offsets = { readonly start: number; readonly end: number };

type Snapshot = {
  readonly value: string;
  /**
   * Where to put the cursor if we go back to this state.
   */
  readonly selection: Offsets;
  readonly kind: string;
  readonly time: number;
};

const TYPING_MERGE_MS = 1000;

const CHIP_CLASS = "format-chip";

/**
 * A `<br>` at the very end of the editor.
 * Without this, a trailing newline would not be visible and the cursor could not get past it.
 * This is not part of the value.
 */
const SENTINEL_CLASS = "trailing-newline";

function createSentinel() {
  const br = document.createElement("br");
  br.className = SENTINEL_CLASS;
  return br;
}

function createOption(name: string) {
  // An empty name is legal but would make an invisible menu item.
  return new Option(name == "" ? "(empty)" : name, name);
}

const BLOCK_ELEMENTS = new Set(["DIV", "P", "LI", "PRE", "BLOCKQUOTE"]);

/**
 * Convert DOM nodes into units.
 *
 * This understands our chips, but it also does something reasonable with
 * whatever else the browser might have added, like `<br>` or `<div>`.
 * It is used on the editor itself and on copies of the current selection.
 * @param parent Read all of the children of this node.
 * @param result Append to this.
 * @returns `result`.
 */
function unitsFromNodes(parent: Node, result: Unit[] = []): Unit[] {
  for (const node of parent.childNodes) {
    if (node instanceof Text) {
      pushContent(result, node.data);
    } else if (node instanceof HTMLElement) {
      if (node.classList.contains(CHIP_CLASS)) {
        result.push({ format: node.dataset.name ?? "" });
      } else if (node.classList.contains(SENTINEL_CLASS)) {
        // Display only.
      } else if (node.tagName == "BR") {
        // A <br> at the end of a block doesn't make a visible line.
        // Chrome adds one as a placeholder when you delete everything.
        if (node.nextSibling) {
          result.push("\n");
        }
      } else {
        if (
          BLOCK_ELEMENTS.has(node.tagName) &&
          result.length > 0 &&
          result.at(-1) != "\n"
        ) {
          result.push("\n");
        }
        unitsFromNodes(node, result);
      }
    }
  }
  return result;
}
