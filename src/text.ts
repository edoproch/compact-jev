/** Whether a UTF-16 boundary falls inside a surrogate pair. */
function splitsPair(text: string, index: number): boolean {
  const before = text.charCodeAt(index - 1);
  const after = text.charCodeAt(index);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

/** A prefix within a UTF-16 length budget, without splitting a Unicode character. */
export function textHead(text: string, chars: number): string {
  let end = Math.min(text.length, Math.max(0, Math.floor(chars)));
  if (splitsPair(text, end)) end -= 1;
  return text.slice(0, end);
}

/** A suffix within a UTF-16 length budget, without splitting a Unicode character. */
export function textTail(text: string, chars: number): string {
  let start = Math.max(0, text.length - Math.max(0, Math.floor(chars)));
  if (splitsPair(text, start)) start += 1;
  return text.slice(start);
}
