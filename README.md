# Format Editor Prototype

A "smart" input for strings like `⸨format1⸩content1⸨format2⸩content2`, the input to
[`MultiTextComponent.addText1()`](https://github.com/TradeIdeasPhilip/canvas-recorder/blob/b238804bf2e63c88bc678a313faf52128b7037e3/src/slide-components/multi-text.ts#L290-L298).

Text is ordinary editable text. Each `⸨name⸩` is an atomic chip displayed as a `<select>`.

```
npm install
npm run dev     # try it
npm test        # unit tests for the string model
npm run build   # type check, then build into docs/ for GitHub Pages
```

## Behavior

- Copy and cut put `⸨name⸩content` on the clipboard as plain text, so you can paste into VS Code.
- Paste parses `⸨…⸩` into chips. Unmatched `⸨` or `⸩` are dropped, because `addText1()` has no way to escape them.
- New chips come only from paste, from the **Insert format** button, or from the editor restoring the required leading format.
- An unknown name is red. Its menu lists the unknown name plus every known name. Pick a known one and the unknown one disappears.
- Changing the list of known names recolors every chip immediately.
- The value always starts with a format. Delete the first chip, or everything, and the same format comes back.
- Enter inserts `\n`. Ctrl-B and similar are ignored.
- Undo and redo are handled by the editor, not the browser.
- Drag and drop is disabled in this prototype.

## How it works

`src/format-string.ts` is the pure model. A string becomes an array of units. Each unit is one UTF-16 code unit of text or one whole format, so each unit is exactly one caret position.

`src/format-editor.ts` is the `contenteditable` wrapper.

- Typing and deleting are left to the browser, so IME, spell check, and autocorrect keep working. After each `input` event we check the DOM and rebuild it if the browser added anything unexpected.
- Paste, cut, copy, Enter, undo, and insert-format work on the unit array. We save the selection as logical offsets, edit the array, re-render, then restore the selection.
