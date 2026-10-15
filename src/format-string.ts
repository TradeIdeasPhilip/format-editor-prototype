// MARK: Format String

/**
 * The pure data model behind the editor.  No DOM in this file.
 *
 * The external format is the one accepted by `MultiTextComponent.addText1()`:
 * `"⸨format1⸩content1⸨format2⸩content2"`.
 *
 * Internally we use an array of {@link Unit}s.  Each unit is exactly one caret
 * position wide:  one UTF-16 code unit of content, or one entire format marker.
 * That makes "replace the selection with this" a simple `Array.splice()`, and it
 * matches the way the DOM counts offsets inside a text node.
 */

export const OPEN = "⸨";
export const CLOSE = "⸩";

/**
 * One format marker, e.g. `⸨title⸩`.
 *
 * `name` can be anything that doesn't contain {@link OPEN} or {@link CLOSE}.
 * Whether that name is one of the *known* formats is a separate question, answered by the editor.
 */
export type FormatUnit = { readonly format: string };

/**
 * Either a single UTF-16 code unit of content or a whole format marker.
 */
export type Unit = string | FormatUnit;

export function isFormat(unit: Unit | undefined): unit is FormatUnit {
  return typeof unit == "object";
}

/**
 * Content may not contain the bracket characters.
 * There is no escape mechanism in `addText1()`, so stray brackets can only be dropped.
 */
const strayBrackets = /[⸨⸩]/g;

/**
 * Remove anything that can't legally appear in content.
 * Also normalize Windows and old Mac line endings.
 */
export function cleanContent(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(strayBrackets, "");
}

/**
 * Append each code unit of `text` to `units`, after cleaning it.
 * @returns `units`, for chaining.
 */
export function pushContent(units: Unit[], text: string): Unit[] {
  // split("") gives UTF-16 code units, which is what the DOM uses for offsets.
  units.push(...cleanContent(text).split(""));
  return units;
}

/**
 * Convert a string, presumably from the clipboard, into units.
 *
 * Every complete `⸨…⸩` becomes a format.
 * The name is kept exactly as is, even if it isn't a known format.
 * Any unmatched `⸨` or `⸩` is silently dropped.
 *
 * Unlike `addText1()`, this does *not* require a leading format.
 * You might be pasting into the middle of some existing text.
 */
export function parse(text: string): Unit[] {
  const result: Unit[] = [];
  const formatMarker = /⸨([^⸨⸩]*)⸩/g;
  let position = 0;
  for (const match of text.matchAll(formatMarker)) {
    pushContent(result, text.slice(position, match.index));
    result.push({ format: match[1] });
    position = match.index + match[0].length;
  }
  pushContent(result, text.slice(position));
  return result;
}

/**
 * The inverse of {@link parse}.
 */
export function serialize(units: readonly Unit[]): string {
  return units
    .map((unit) => (isFormat(unit) ? OPEN + unit.format + CLOSE : unit))
    .join("");
}

/**
 * Walk backwards from `offset` to find the format that applies there.
 * @returns The name of the format, or undefined if there is no format before `offset`.
 */
export function formatInEffect(
  units: readonly Unit[],
  offset: number,
): string | undefined {
  for (let i = Math.min(offset, units.length) - 1; i >= 0; i--) {
    const unit = units[i];
    if (isFormat(unit)) {
      return unit.format;
    }
  }
  return undefined;
}

export type Span = { readonly format: string; readonly content: string };

/**
 * A copy of the parser in `MultiTextComponent.addText1()`, so we can prove
 * that our output is acceptable to the real consumer.
 * @param all The string that would be passed to `addText1()`.
 * @returns The arguments that `addText1()` would pass to `addText()`.
 * @throws Exactly when `addText1()` would throw.
 */
export function addText1Spans(all: string): Span[] {
  const splitter = /^⸨([^⸨⸩]*)⸩([^⸨⸩]*)(.*)$/s;
  const result: Span[] = [];
  while (all != "") {
    const pieces = splitter.exec(all);
    if (!pieces) {
      throw new Error("Invalid here:  " + all);
    }
    result.push({ format: pieces[1], content: pieces[2] });
    all = pieces[3];
  }
  return result;
}
