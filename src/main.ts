// This is the preferred way to include a css file.
import "./style.css";
import { getById } from "phil-lib/client-misc";
import { FormatEditor } from "./format-editor.ts";
import { addText1Spans } from "./format-string.ts";

const knownNamesInput = getById("known-names", HTMLTextAreaElement);
const knownNamesWarning = getById("known-names-warning", HTMLDivElement);
const insertButton = getById("insert-format", HTMLButtonElement);
const valueOutput = getById("value", HTMLTextAreaElement);
const spansBody = getById("spans", HTMLTableElement).tBodies[0];

knownNamesInput.value = ["title", "body", "code", "emphasis"].join("\n");

/**
 * One name per line.  Leading and trailing spaces are ignored.
 * Names containing ⸨ or ⸩ could never appear in addText1() input, so they are rejected.
 */
function readKnownNames(): string[] {
  const names = new Set<string>();
  const rejected: string[] = [];
  for (const line of knownNamesInput.value.split("\n")) {
    const name = line.trim();
    if (name == "") {
      continue;
    }
    if (/[⸨⸩]/.test(name)) {
      rejected.push(name);
    } else {
      names.add(name);
    }
  }
  knownNamesWarning.textContent =
    rejected.length == 0
      ? ""
      : `Ignored because format names can't contain ⸨ or ⸩:  ${rejected.join(", ")}`;
  return [...names];
}

const editor = new FormatEditor(
  "⸨title⸩Hello, ⸨emphasis⸩world⸨title⸩!\n⸨body⸩Call ⸨code⸩addText1()⸨body⸩ to draw this.  ⸨typo⸩This format is unknown.",
  readKnownNames(),
);
getById("editor-holder", HTMLDivElement).append(editor.element);

function showValue() {
  const value = editor.value;
  valueOutput.value = value;
  const known = new Set(editor.knownNames);
  try {
    const rows = addText1Spans(value).map(({ format, content }) => {
      const row = document.createElement("tr");
      const formatCell = row.insertCell();
      formatCell.textContent = format;
      formatCell.classList.toggle("invalid", !known.has(format));
      row.insertCell().textContent = JSON.stringify(content);
      return row;
    });
    spansBody.replaceChildren(...rows);
  } catch (reason) {
    // This should never happen.  The editor always produces valid input.
    const row = document.createElement("tr");
    const cell = row.insertCell();
    cell.colSpan = 2;
    cell.className = "invalid";
    cell.textContent = String(reason);
    spansBody.replaceChildren(row);
  }
}

editor.onChange = showValue;
knownNamesInput.addEventListener("input", () => {
  editor.knownNames = readKnownNames();
  showValue();
});
// Keep the focus, and therefore the cursor, in the editor.
insertButton.addEventListener("mousedown", (event) => event.preventDefault());
insertButton.addEventListener("click", () => editor.insertFormat());
showValue();

// For poking at in the console.
(window as any).editor = editor;
