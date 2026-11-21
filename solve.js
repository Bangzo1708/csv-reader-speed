// solve.js — a fast drop-in replacement for csv-reader 1.0.0.
//
// Written by hand from the competition specification alone
// (competition.yaml / RULES.txt): one left-to-right pass over the text,
// commas and double quotes.
//
//   - A U+FEFF at the very start is dropped.
//   - A record ends at LF or CRLF; a line left with no characters is no record.
//   - Outside quotes a CR not followed by LF is dropped (error stray_cr).
//   - A field that opens with a quote runs to the next quote that is not
//     doubled: "" inside it is one quote, and each CRLF or lone CR inside it
//     reads as LF. What follows its closing quote, up to the next comma or
//     line break, is appended as it stands (error quote_junk, when the field
//     ends). A quote that never closes is a literal character, and the text
//     after it is read again as unquoted (error unterminated_quote). A quote
//     inside an unquoted field is a literal character.
//   - Fields stay strings, never trimmed or converted.
//   - columns is the first record when header is true, else null; rows holds
//     the records after it (every record when header is false), each padded
//     with "" (error short_row, with fields: its field count) or cut (error
//     long_row, with extra: the cut fields) to the first record's width.
//   - Each error is {code, line, row} in the order met; line is the 1-based
//     line its record starts on (counting every LF, CRLF and lone CR inside
//     quotes), row its record's index in rows, null for the header.
//
// Speed: three paths, fastest first.
//   1. Fast path — a line with no quote at all: one slice, String.split.
//   2. Line path — a line with quotes but no CR, where every quoted field
//      closes on the same line: fields are cut out of the line slice with
//      one indexOf per field, so no scan ever leaves the line. If a quoted
//      field does not close on the line, this path bails out (returning null)
//      and the record is re-read by the general path.
//   3. General path — a line with a stray CR, or a record whose quoted field
//      spans lines: field by field over the raw text, locating each field's
//      end with two indexOf calls (comma, LF) and checking the cut value for
//      stray CRs. Only a quoted field that holds a line break is walked, once,
//      and those are rare.

const COMMA = 44;
const QUOTE = 34;
const LF = 10;
const CR = 13;
const BOM = 0xfeff;

/**
 * Parse one record whose line holds quotes but no CR, and whose quoted
 * fields all close on that line. `line` is the line's content (no line
 * break, no trailing CRLF CR). Returns {fields, errs}, or null when a
 * quoted field does not close on this line (the record spans lines).
 * Errors are collected, not pushed, so a bail-out leaves nothing behind.
 *
 * Fields are cut out of the line slice with one indexOf per field, so no
 * scan ever leaves the line. (A split-then-repair variant was tried and
 * measured slower: split materialises an array and every piece per line.)
 */
function parseRecordLine(line, recLine, rowForErr) {
  const fields = [];
  const errs = [];
  const L = line.length;
  let p = 0;

  for (;;) {
    if (p >= L) {
      // A trailing comma left an empty field at the end of the line.
      fields.push('');
      break;
    }
    if (line.charCodeAt(p) === QUOTE) {
      // Quoted field: find its closing quote inside this line.
      let q = p + 1;
      let close = -1;
      let escaped = false;
      for (;;) {
        const found = line.indexOf('"', q);
        if (found === -1) break;
        if (line.charCodeAt(found + 1) === QUOTE) {
          escaped = true;
          q = found + 2;
          continue;
        }
        close = found;
        break;
      }
      if (close === -1) return null; // spans lines: let the general path take it
      let value = escaped
        ? line.slice(p + 1, close).replaceAll('""', '"')
        : line.slice(p + 1, close);
      // Junk after the closing quote, up to the next comma or the line end.
      const comma = line.indexOf(',', close + 1);
      const junkEnd = comma === -1 ? L : comma;
      if (junkEnd > close + 1) {
        value += line.slice(close + 1, junkEnd);
        errs.push({ code: 'quote_junk', line: recLine, row: rowForErr });
      }
      fields.push(value);
      if (comma === -1) break; // the record ends at the line end
      p = comma + 1;
      continue;
    }
    // Unquoted field: to the next comma or the line end. A quote in here
    // is a literal character.
    const comma = line.indexOf(',', p);
    if (comma === -1) {
      fields.push(line.slice(p));
      break;
    }
    fields.push(line.slice(p, comma));
    p = comma + 1;
  }

  return { fields, errs };
}

/**
 * Parse one record that holds at least one quote and is not covered by the
 * line path: a stray CR in the line, or a quoted field spanning lines.
 * Returns [fields, nextPos, nextLine]. `line` is the running line number;
 * `recLine` is the line this record started on, used for every error of the
 * record; `rowForErr` is the record's index in rows (null for the header).
 */
function parseRecordSlow(text, n, start, line, recLine, rowForErr, errors) {
  const fields = [];
  let pos = start;
  let done = false;

  // Count the stray CRs in `value` and drop them, one error each.
  const dropStrayCRs = (value) => {
    let count = 0;
    let p = value.indexOf('\r');
    while (p !== -1) {
      count += 1;
      p = value.indexOf('\r', p + 1);
    }
    for (let k = 0; k < count; k++) {
      errors.push({ code: 'stray_cr', line: recLine, row: rowForErr });
    }
    return value.split('\r').join('');
  };

  while (!done) {
    if (pos >= n) {
      // A trailing comma left an empty field at the end of the text.
      fields.push('');
      done = true;
      break;
    }
    const ch = text.charCodeAt(pos);
    if (ch === LF) {
      // A comma left an empty field at the end of the line.
      fields.push('');
      pos += 1;
      line += 1;
      done = true;
      break;
    }
    if (ch === CR) {
      if (text.charCodeAt(pos + 1) === LF) {
        fields.push('');
        pos += 2;
        line += 1;
        done = true;
        break;
      }
      // A lone CR at the start of a field: dropped, the field goes on.
      errors.push({ code: 'stray_cr', line: recLine, row: rowForErr });
      pos += 1;
      continue;
    }

    if (ch === QUOTE) {
      // Quoted field: find the closing quote, the next quote that is not doubled.
      let q = pos + 1;
      let close = -1;
      let escaped = false;
      for (;;) {
        const found = text.indexOf('"', q);
        if (found === -1) break;
        if (text.charCodeAt(found + 1) === QUOTE) {
          escaped = true;
          q = found + 2;
          continue;
        }
        close = found;
        break;
      }

      if (close === -1) {
        // The quote never closes: it is a literal character and the text
        // after it is read again as unquoted, from the opening quote on.
        errors.push({ code: 'unterminated_quote', line: recLine, row: rowForErr });
        // Fall through to the unquoted parse below, starting at pos.
      } else {
        // Build the field value from text[pos + 1 .. close).
        let value;
        const crIn = text.indexOf('\r', pos + 1);
        const hasCR = crIn !== -1 && crIn < close;
        const lfIn = text.indexOf('\n', pos + 1);
        const hasLF = lfIn !== -1 && lfIn < close;
        if (!hasCR && !hasLF) {
          value = escaped
            ? text.slice(pos + 1, close).replaceAll('""', '"')
            : text.slice(pos + 1, close);
        } else {
          // Rare: line breaks inside the quotes. Walk the segment once,
          // turning every CRLF or lone CR into LF and counting lines.
          const parts = [];
          let p = pos + 1;
          while (p < close) {
            let nq = text.indexOf('"', p);
            if (nq === -1 || nq > close) nq = close;
            let nr = text.indexOf('\r', p);
            if (nr === -1 || nr > close) nr = close;
            let nn = text.indexOf('\n', p);
            if (nn === -1 || nn > close) nn = close;
            let nx = nq;
            if (nr < nx) nx = nr;
            if (nn < nx) nx = nn;
            if (nx > p) parts.push(text.slice(p, nx));
            if (nx >= close) break;
            const cc = text.charCodeAt(nx);
            if (cc === QUOTE) {
              parts.push('"');
              p = nx + 2;
            } else if (cc === CR) {
              parts.push('\n');
              line += 1;
              p = nx + (text.charCodeAt(nx + 1) === LF ? 2 : 1);
            } else {
              parts.push('\n');
              line += 1;
              p = nx + 1;
            }
          }
          value = parts.join('');
        }

        // Junk after the closing quote, up to the next comma or line break.
        // A CR before either is a stray CR: dropped, the junk goes on.
        const cPos = text.indexOf(',', close + 1);
        const nPos = text.indexOf('\n', close + 1);
        let end;
        let term; // 0 EOF, 1 comma, 2 LF
        if (cPos !== -1 && (nPos === -1 || cPos < nPos)) { end = cPos; term = 1; }
        else if (nPos !== -1) { end = nPos; term = 2; }
        else { end = n; term = 0; }
        let junk;
        if (term === 2 && end > close + 1 && text.charCodeAt(end - 1) === CR) {
          junk = text.slice(close + 1, end - 1); // CRLF: the CR is the line break
        } else {
          junk = text.slice(close + 1, end);
        }
        if (junk.indexOf('\r') !== -1) junk = dropStrayCRs(junk);
        if (junk !== '') {
          value += junk;
          errors.push({ code: 'quote_junk', line: recLine, row: rowForErr });
        }
        fields.push(value);
        if (term === 1) { pos = end + 1; continue; }
        if (term === 2) { pos = end + 1; line += 1; }
        else { pos = n; }
        done = true;
        break;
      }
    }

    // Unquoted field (also the re-read after an unterminated quote).
    // A quote in here is a literal character: the scan looks only for
    // comma and LF. A CR before either is a stray CR: dropped, the field
    // goes on.
    const cPos = text.indexOf(',', pos);
    const nPos = text.indexOf('\n', pos);
    let end;
    let term; // 0 EOF, 1 comma, 2 LF
    if (cPos !== -1 && (nPos === -1 || cPos < nPos)) { end = cPos; term = 1; }
    else if (nPos !== -1) { end = nPos; term = 2; }
    else { end = n; term = 0; }
    let value;
    if (term === 2 && end > pos && text.charCodeAt(end - 1) === CR) {
      value = text.slice(pos, end - 1); // CRLF: the CR is the line break
    } else {
      value = text.slice(pos, end);
    }
    if (value.indexOf('\r') !== -1) value = dropStrayCRs(value);
    fields.push(value);
    if (term === 1) { pos = end + 1; continue; }
    if (term === 2) { pos = end + 1; line += 1; }
    else { pos = n; }
    done = true;
  }

  return [fields, pos, line];
}

export function run(input) {
  const text = input.text;
  const header = input.header === true;
  const n = text.length;

  let i = 0;
  if (n > 0 && text.charCodeAt(0) === BOM) i = 1;

  const rows = [];
  const errors = [];
  let columns = null;
  let width = -1;
  let line = 1; // line number of the record being parsed
  let recNo = 0; // records finished so far, header included

  while (i < n) {
    const recLine = line;
    const rowForErr = header && recNo === 0 ? null : recNo - (header ? 1 : 0);

    const c0 = text.charCodeAt(i);
    if (c0 === LF) {
      // A line left with no characters is no record.
      i += 1;
      line += 1;
      continue;
    }
    if (c0 === CR) {
      if (text.charCodeAt(i + 1) === LF) {
        i += 2;
        line += 1;
        continue;
      }
      // A lone CR at the start of a line: dropped, the line goes on.
      errors.push({ code: 'stray_cr', line: recLine, row: rowForErr });
      i += 1;
      continue;
    }

    // Find where this record's line ends.
    const nl = text.indexOf('\n', i);
    const hasNL = nl !== -1;
    const lineEnd = hasNL ? nl : n;
    let contentEnd = lineEnd;
    if (hasNL && lineEnd > i && text.charCodeAt(lineEnd - 1) === CR) contentEnd = lineEnd - 1;

    let fields = null;
    if (contentEnd > i) {
      const content = text.slice(i, contentEnd);
      if (content.indexOf('"') === -1) {
        // Fast path: no quote anywhere in this line, so the record ends
        // here and no field can span a line break.
        if (content.indexOf('\r') === -1) {
          fields = content.split(',');
        } else {
          // Lone CRs inside the line: each is dropped with a stray_cr error.
          let count = 0;
          let p = content.indexOf('\r');
          while (p !== -1) {
            count += 1;
            p = content.indexOf('\r', p + 1);
          }
          for (let k = 0; k < count; k++) {
            errors.push({ code: 'stray_cr', line: recLine, row: rowForErr });
          }
          const cleaned = content.split('\r').join('');
          if (cleaned === '') {
            // The line held nothing but dropped CRs: no record.
            i = hasNL ? lineEnd + 1 : n;
            line += 1;
            continue;
          }
          fields = cleaned.split(',');
        }
        i = hasNL ? lineEnd + 1 : n;
        line += 1;
      } else if (content.indexOf('\r') === -1) {
        // Line path: quotes, but no CR and every quoted field closes here.
        const med = parseRecordLine(content, recLine, rowForErr);
        if (med !== null) {
          fields = med.fields;
          for (const e of med.errs) errors.push(e);
          i = hasNL ? lineEnd + 1 : n;
          line += 1;
        }
        // med === null: a quoted field spans lines; fall through below.
      }
    }
    if (fields === null) {
      if (contentEnd <= i) {
        // Empty line (defensive; the checks above normally catch it).
        i = hasNL ? lineEnd + 1 : n;
        line += 1;
        continue;
      }
      // General path: a stray CR in the line, or a quoted field spanning lines.
      const out = parseRecordSlow(text, n, i, line, recLine, rowForErr, errors);
      fields = out[0];
      i = out[1];
      line = out[2];
    }

    // Finish the record: first record sets the width, the rest are padded
    // with "" or cut to it.
    if (width === -1) {
      width = fields.length;
      if (header) columns = fields;
      else rows.push(fields);
    } else if (fields.length < width) {
      errors.push({ code: 'short_row', line: recLine, row: rowForErr, fields: fields.length });
      while (fields.length < width) fields.push('');
      rows.push(fields);
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recLine, row: rowForErr, extra: fields.slice(width) });
      fields.length = width;
      rows.push(fields);
    } else {
      rows.push(fields);
    }
    recNo += 1;
  }

  // With a header but no record at all, columns is the empty record.
  if (header && columns === null) columns = [];

  return { columns, rows, errors };
}
