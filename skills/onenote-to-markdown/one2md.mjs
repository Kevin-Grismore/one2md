#!/usr/bin/env node

// src/cli.ts
import * as nodeFs2 from "node:fs";
import * as nodePath2 from "node:path";

// src/convert-file.ts
import { createHash } from "node:crypto";

// src/onenote-file/ink-svg.ts
var PADDING = 10;
function strokesToSvg(strokes) {
  const drawable = strokes.filter((stroke) => stroke.points.length > 0);
  if (drawable.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const stroke of drawable) {
    for (const point of stroke.points) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
  }
  const width = maxX - minX + PADDING * 2;
  const height = maxY - minY + PADDING * 2;
  const paths = [];
  for (const stroke of drawable) {
    const opacityAttr = stroke.opacity < 1 ? ` opacity="${stroke.opacity.toFixed(2)}"` : "";
    if (stroke.points.length === 1) {
      const { x, y } = stroke.points[0];
      paths.push(`<circle cx="${x - minX + PADDING}" cy="${y - minY + PADDING}" r="${stroke.width / 2}" fill="${stroke.color}"${opacityAttr}/>`);
      continue;
    }
    const pathData = stroke.points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x - minX + PADDING} ${point.y - minY + PADDING}`).join(" ");
    paths.push(`<path d="${pathData}" stroke="${stroke.color}" stroke-width="${stroke.width}" fill="none" stroke-linecap="round" stroke-linejoin="round"${opacityAttr}/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${paths.join("\n")}</svg>`;
}

// src/onenote-file/util.ts
function extensionFromName(name) {
  return name?.match(/\.([^.\s\\/]+)$/)?.[1] ?? null;
}
function extensionFromBytes(bytes) {
  const magic = (offset, ...signature) => signature.every((byte, i) => bytes[offset + i] === byte);
  const tag = (offset) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (magic(0, 137, 80, 78, 71)) return "png";
  if (magic(0, 255, 216, 255)) return "jpg";
  if (magic(0, 71, 73, 70, 56)) return "gif";
  if (magic(0, 37, 80, 68, 70)) return "pdf";
  if (magic(0, 73, 73, 42, 0) || magic(0, 77, 77, 0, 42)) return "tiff";
  if (magic(0, 66, 77)) return "bmp";
  if (magic(0, 31, 139)) return "gz";
  if (magic(0, 73, 68, 51)) return "mp3";
  if (tag(0) === "RIFF") {
    if (tag(8) === "WEBP") return "webp";
    if (tag(8) === "WAVE") return "wav";
  }
  if (tag(4) === "ftyp") {
    const brand = tag(8);
    if (brand.startsWith("avi")) return "avif";
    if (brand.startsWith("hei") || brand === "mif1" || brand === "msf1") return "heic";
    if (brand.startsWith("qt")) return "mov";
    return "mp4";
  }
  if (magic(0, 80, 75, 3, 4)) return "zip";
  return null;
}

// src/onenote-file/convert.ts
var PIXELS_PER_INK_UNIT = 48;
var INVISIBLE_MATH = /[\u2061-\u2064]/g;
var SUPERSCRIPTS = "\u2070\xB9\xB2\xB3\u2074\u2075\u2076\u2077\u2078\u2079\u207A\u207B\u207C\u207D\u207E\u207F\u2071\xB9\xB2\xB3";
var SUPERSCRIPT_PLAIN = "0123456789+-=()ni123";
var SUBSCRIPTS = "\u2080\u2081\u2082\u2083\u2084\u2085\u2086\u2087\u2088\u2089\u208A\u208B\u208C\u208D\u208E";
var SUBSCRIPT_PLAIN = "0123456789+-=()";
function scriptRuns(text, glyphs, plain, marker) {
  const pattern = new RegExp(`[${glyphs}]+`, "g");
  return text.replace(pattern, (match) => {
    const decoded = [...match].map((character) => plain[glyphs.indexOf(character)]).join("");
    return `${marker}{${decoded}}`;
  });
}
function toLatex(text) {
  const scripted = scriptRuns(
    scriptRuns(text, SUPERSCRIPTS, SUPERSCRIPT_PLAIN, "^"),
    SUBSCRIPTS,
    SUBSCRIPT_PLAIN,
    "_"
  );
  return scripted.normalize("NFKC").replace(INVISIBLE_MATH, "").trim();
}
function escapeInline(text) {
  return text.replace(/[[\]`<]/g, "\\$&");
}
function escapeLineStart(line) {
  return line.replace(/^(\s*)(#{1,6}(?=\s|$)|>|\||[-*+](?=\s)|\d+[.)](?=\s)|`{3,}|~{3,}|-{3,}$|={3,}$)/, "$1\\$2");
}
function internalPageTitle(url) {
  if (!url.toLowerCase().startsWith("onenote:")) return void 0;
  const hash = url.indexOf("#");
  if (hash < 0) return void 0;
  const tail = url.slice(hash + 1);
  const separator = tail.indexOf("&");
  const encoded = tail.slice(0, separator < 0 ? tail.length : separator);
  if (encoded === "") return void 0;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}
function renderRun(run, options) {
  let text = run.text;
  if (text === "") return "";
  const leading = text.match(/^\s*/)[0];
  const trailing = text.length > leading.length ? text.match(/\s*$/)[0] : "";
  let core = text.slice(leading.length, text.length - trailing.length);
  if (core !== "") {
    if (run.math) {
      const latex = toLatex(core);
      return latex === "" ? "" : `${leading}$${latex}$${trailing}`;
    }
    core = escapeInline(core);
    if (run.highlight) core = highlighted(core, run.highlight);
    if (run.superscript) core = `<sup>${core}</sup>`;
    if (run.subscript) core = `<sub>${core}</sub>`;
    if (run.underline) core = `<u>${core}</u>`;
    if (run.bold) core = `**${core}**`;
    if (run.italic) core = `*${core}*`;
    if (run.strikethrough) core = `~~${core}~~`;
    if (run.hyperlinkUrl) {
      const pageTitle = internalPageTitle(run.hyperlinkUrl);
      const target = pageTitle ? options.resolveInternalLink?.(pageTitle) ?? pageTitle : run.hyperlinkUrl;
      core = `[${core}](${encodeURI(target)})`;
    }
  }
  return leading + core + trailing;
}
function renderRuns(runs, options) {
  return runs.map((run) => renderRun(run, options)).join("").replace(/\r\n?/g, "\n").trim();
}
var HIGHLIGHT_MARKERS = [
  { marker: "\u{1F534}", inks: [[255, 0, 0], [255, 105, 180]] },
  { marker: "\u{1F7E0}", inks: [[255, 165, 0]] },
  { marker: "\u{1F7E1}", inks: [[255, 255, 0]] },
  { marker: "\u{1F7E2}", inks: [[0, 255, 0], [0, 128, 0]] },
  { marker: "\u{1F535}", inks: [[0, 0, 255], [0, 255, 255]] },
  { marker: "\u{1F7E3}", inks: [[128, 0, 128], [255, 0, 255]] }
];
function highlighted(text, color) {
  const match = color.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!match) return `==${text}==`;
  const [red, green, blue] = match.slice(1).map((part) => parseInt(part, 16));
  let nearest = HIGHLIGHT_MARKERS[0].marker;
  let best = Infinity;
  for (const { marker, inks } of HIGHLIGHT_MARKERS) {
    for (const [inkRed, inkGreen, inkBlue] of inks) {
      const distance = (inkRed - red) ** 2 + (inkGreen - green) ** 2 + (inkBlue - blue) ** 2;
      if (distance < best) {
        best = distance;
        nearest = marker;
      }
    }
  }
  return `==${nearest}${text}==`;
}
function headingPrefix(styleId) {
  const level = styleId?.match(/^h([1-6])$/i);
  return level ? "#".repeat(Number(level[1])) + " " : "";
}
function listPrefix(list) {
  if (!list) return "";
  return "	".repeat(list.level) + (list.ordered ? "1. " : "- ");
}
function taskPrefix(tags, list) {
  const task = tags?.find((tag) => tag.checkable);
  if (!task) return void 0;
  return "	".repeat(list?.level ?? 0) + (task.completed ? "- [x] " : "- [ ] ");
}
var CALLOUT_SHAPES = {
  13: "important",
  // Yellow star
  15: "question",
  // Question mark
  17: "danger",
  // High priority (red exclamation mark)
  21: "tip",
  // Light bulb
  111: "question"
  // Question balloon
};
function calloutFor(tags) {
  for (const tag of tags ?? []) {
    if (tag.checkable || tag.shape === void 0) continue;
    const type = CALLOUT_SHAPES[tag.shape];
    if (type) return { type, title: tag.label };
  }
  return void 0;
}
function withExtension(base, extension) {
  if (!extension) return base;
  if (extensionFromName(base)) return base;
  return base + (extension.startsWith(".") ? extension : `.${extension}`);
}
var PageWriter = class {
  constructor(options, pageTitle) {
    this.options = options;
    this.pageTitle = pageTitle;
  }
  blocks = [];
  inkStrokes = [];
  recognizedText = [];
  attachments = [];
  get markdown() {
    const lines = [];
    for (const [index, block] of this.blocks.entries()) {
      const previous = this.blocks[index - 1];
      if (previous && !(block.listItem && previous.listItem)) lines.push("");
      lines.push(block.text);
    }
    return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }
  push(text, listItem = false) {
    this.blocks.push({ text, listItem });
  }
  pushCallout(callout, body) {
    const quoted = body.split("\n").map((line) => `> ${line}`).join("\n");
    const previous = this.blocks[this.blocks.length - 1];
    const opening = `> [!${callout.type}]${callout.title ? ` ${callout.title}` : ""}`;
    if (previous?.callout === opening) {
      previous.text += `
>
${quoted}`;
      return;
    }
    this.blocks.push({ text: `${opening}
${quoted}`, listItem: false, callout: opening });
  }
  async writeElements(elements) {
    for (const element of elements) {
      if (this.options.isCancelled?.()) return;
      await this.writeElement(element);
    }
  }
  async writeElement(element) {
    switch (element.kind) {
      case "outline":
        await this.writeElements(element.children);
        break;
      case "paragraph":
        await this.writeParagraph(element);
        break;
      case "table":
        await this.writeTable(element);
        break;
      case "image":
        await this.writeAsset(element.data, this.imageName(element), "", true);
        break;
      case "embedded-file": {
        const name = withExtension(element.fileName ?? "attachment", element.extension);
        await this.writeAsset(element.data, name, name, false);
        break;
      }
      case "ink":
        this.collectInk(element);
        break;
    }
  }
  async writeParagraph(paragraph) {
    const text = renderRuns(paragraph.runs, this.options);
    if (text !== "") {
      const task = taskPrefix(paragraph.tags, paragraph.list);
      const prefix = task ?? listPrefix(paragraph.list) ?? "";
      const indent = "	".repeat(paragraph.list?.level ?? 0);
      const escaped = text.split("\n").map(escapeLineStart);
      const body = (prefix || headingPrefix(paragraph.styleId)) + escaped.join("  \n" + indent);
      const callout = calloutFor(paragraph.tags);
      if (callout && !paragraph.list && !task) this.pushCallout(callout, body);
      else this.push(body, task !== void 0 || paragraph.list !== void 0);
    }
    await this.writeElements(paragraph.children);
  }
  async writeTable(table) {
    if (table.rows.length === 0) return;
    const columns = Math.max(...table.rows.map((row) => row.cells.length));
    const rendered = [];
    for (const row of table.rows) {
      const cells = [];
      for (let index = 0; index < columns; index++) {
        const text = await this.renderCell(row.cells[index]?.children ?? []);
        cells.push(text.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim());
      }
      rendered.push(cells);
    }
    const lines = [
      `| ${rendered[0].join(" | ")} |`,
      `| ${new Array(columns).fill("---").join(" | ")} |`,
      ...rendered.slice(1).map((row) => `| ${row.join(" | ")} |`)
    ];
    this.push(lines.join("\n"));
  }
  collectInk(ink) {
    for (const stroke of ink.strokes) {
      this.inkStrokes.push({
        points: stroke.points.map((point) => ({ x: point.x * PIXELS_PER_INK_UNIT, y: point.y * PIXELS_PER_INK_UNIT })),
        color: stroke.color,
        width: Math.max(1, stroke.width * PIXELS_PER_INK_UNIT),
        opacity: stroke.opacity
      });
    }
    if (ink.recognizedText && ink.recognizedText !== this.recognizedText[this.recognizedText.length - 1]) {
      this.recognizedText.push(ink.recognizedText);
    }
  }
  async writeCollectedInk() {
    const svg = strokesToSvg(this.inkStrokes);
    if (!svg) return;
    const recognizedText = this.recognizedText.join(" ");
    await this.writeAsset(new TextEncoder().encode(svg), `${this.pageTitle} - Ink.svg`, "", true);
    if (recognizedText !== "") this.push(recognizedText);
  }
  imageName(image) {
    return withExtension(`${this.pageTitle} image`, image.extension ?? extensionFromName(image.fileName) ?? void 0);
  }
  async writeAsset(data, name, label, embed) {
    const link = await this.renderAsset(data, name, label, embed);
    if (link) this.push(link);
  }
  async renderAsset(data, name, label, embed) {
    if (!data || data.length === 0) {
      this.options.onSkipped?.(name, "no-data");
      return void 0;
    }
    const attachment = await this.options.saveAttachment(data, name);
    if (!attachment) {
      this.options.onSkipped?.(name, "no-data");
      return void 0;
    }
    this.attachments.push(attachment);
    const target = encodeURI(attachment.path);
    return embed ? `![${label}](${target})` : `[${label}](${target})`;
  }
  async renderCell(children) {
    const parts = [];
    for (const child of children) {
      switch (child.kind) {
        case "paragraph":
          parts.push(renderRuns(child.runs, this.options));
          parts.push(await this.renderCell(child.children));
          break;
        case "outline":
          parts.push(await this.renderCell(child.children));
          break;
        case "image":
          parts.push(await this.renderAsset(child.data, this.imageName(child), "", true) ?? "");
          break;
        case "embedded-file": {
          const name = withExtension(child.fileName ?? "attachment", child.extension);
          parts.push(await this.renderAsset(child.data, name, name, false) ?? "");
          break;
        }
        case "ink":
          this.collectInk(child);
          break;
        case "table":
          this.options.onSkipped?.(this.pageTitle, "not-representable");
          break;
      }
    }
    return parts.filter((part) => part !== "").join(" ");
  }
};
async function convertPage(page, options) {
  const writer = new PageWriter(options, options.noteName ?? page.title);
  await writer.writeElements(page.outlines);
  await writer.writeElements(page.directContent);
  await writer.writeCollectedInk();
  return { markdown: writer.markdown, attachments: writer.attachments };
}

// src/onenote-file/errors.ts
var OneNoteFormatError = class extends Error {
  constructor(code, message, offset) {
    super(offset === void 0 ? message : `${message} (at 0x${offset.toString(16)})`);
    this.code = code;
    this.offset = offset;
    this.name = "OneNoteFormatError";
    this.kind = kindOf(code);
  }
  kind;
};
function kindOf(code) {
  if (code.endsWith("_LIMIT") || code === "ONENOTE_OFFSET_RANGE") return "limit";
  if (code === "ONENOTE_ONEX_PROTECTED") return "protected";
  const unsupported = [
    "ONENOTE_CAB_MSZIP",
    "ONENOTE_CAB_COMPRESSION",
    "ONENOTE_CAB_LZX_WINDOW",
    "ONENOTE_NOT_REVISION_STORE",
    "ONENOTE_UNKNOWN_FILE_FORMAT",
    "ONENOTE_ONEX_UNSUPPORTED",
    "ONENOTE_PROPERTY_TYPE"
  ];
  return unsupported.includes(code) ? "unsupported" : "malformed";
}

// src/names.ts
var slashesRe = /[/\\]/g;
var illegalRe = /[?<>:*|"]/g;
var reservedRe = /^\.+$/;
var windowsReservedRe = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
var windowsTrailingRe = /[. ]+$/;
var startsWithDotRe = /^[.\s]+/;
var badLinkRe = /[[\]#|^]/g;
function stripControlCharacters(name) {
  let out = "";
  for (const ch of name) {
    const code = ch.charCodeAt(0);
    if (code <= 31 || code >= 128 && code <= 159) continue;
    out += ch;
  }
  return out;
}
var MAX_NAME_BYTES = 240;
var WINDOWS_PATH_CHARS = 160;
var NAME_TAIL_CHARS = 8;
var MIN_NAME_CHARS = 24;
var encoder = new TextEncoder();
function charsAvailable(parentPath) {
  if (process.platform !== "win32") return Infinity;
  const used = parentPath ? parentPath.length + 1 : 0;
  return Math.max(MIN_NAME_CHARS, WINDOWS_PATH_CHARS - used - NAME_TAIL_CHARS);
}
function limitNameLength(name, maxChars) {
  if (name.length <= maxChars && (name.length * 3 <= MAX_NAME_BYTES || encoder.encode(name).length <= MAX_NAME_BYTES)) return name;
  let truncated = "";
  let bytes = 0;
  for (const character of name) {
    const size = encoder.encode(character).length;
    if (bytes + size > MAX_NAME_BYTES) break;
    if (truncated.length + character.length > maxChars) break;
    truncated += character;
    bytes += size;
  }
  const lastSpace = truncated.lastIndexOf(" ");
  if (lastSpace > truncated.length / 2) truncated = truncated.slice(0, lastSpace);
  return truncated;
}
function tidyName(name) {
  return name.replace(reservedRe, "").replace(windowsTrailingRe, "").replace(windowsReservedRe, "").replace(badLinkRe, "").replace(startsWithDotRe, "");
}
function sanitizeFileName(name, parentPath) {
  const cleaned = tidyName(stripControlCharacters(
    (name ?? "").normalize("NFC").replace(slashesRe, "-").replace(illegalRe, "")
  ));
  const limited = limitNameLength(cleaned, charsAvailable(parentPath));
  const sanitized = limited === cleaned ? cleaned : tidyName(limited);
  return sanitized.trim() || "Untitled";
}
function availableFileName(fileName, isTaken) {
  const lastDotIndex = fileName.lastIndexOf(".");
  const hasExtension = lastDotIndex > 0;
  const base = hasExtension ? fileName.slice(0, lastDotIndex) : fileName;
  const extension = hasExtension ? fileName.slice(lastDotIndex) : "";
  for (let index = 0; ; index++) {
    const candidate = index === 0 ? fileName : `${base} ${index}${extension}`;
    if (!isTaken(candidate)) return candidate;
  }
}
var NameRegistry = class {
  taken = /* @__PURE__ */ new Map();
  setFor(folder) {
    let set = this.taken.get(folder);
    if (!set) this.taken.set(folder, set = /* @__PURE__ */ new Set());
    return set;
  }
  /** Case-insensitive, because macOS and Windows filesystems are. */
  claim(folder, fileName) {
    const set = this.setFor(folder);
    const chosen = availableFileName(fileName, (candidate) => set.has(candidate.toLowerCase()));
    set.add(chosen.toLowerCase());
    return chosen;
  }
  has(folder, fileName) {
    return this.taken.get(folder)?.has(fileName.toLowerCase()) ?? false;
  }
};

// src/onenote-file/cabinet/lzx.ts
var LITERAL_SYMBOLS = 256;
var PRIMARY_LENGTH_SYMBOLS = 8;
var LENGTH_TREE_SYMBOLS = 249;
var ALIGNED_TREE_SYMBOLS = 8;
var PRETREE_SYMBOLS = 20;
var MAXIMUM_PATH_LENGTH = 16;
var VERBATIM_BLOCK = 1;
var ALIGNED_OFFSET_BLOCK = 2;
var UNCOMPRESSED_BLOCK = 3;
var MAXIMUM_TRANSLATED_FRAMES = 32768;
function corrupt(message) {
  return new OneNoteFormatError("ONENOTE_CAB_LZX_CORRUPT", message);
}
var BitReader = class {
  constructor(data) {
    this.data = data;
  }
  nextWordOffset = 0;
  word = 0;
  bitsRemaining = 0;
  get remainingByteCount() {
    this.ensureByteAligned();
    return this.data.length - this.nextWordOffset;
  }
  readBits(count) {
    let value = 0;
    let remaining = count;
    while (remaining > 0) {
      if (this.bitsRemaining === 0) this.loadWord();
      const take = Math.min(remaining, this.bitsRemaining);
      const shift = this.bitsRemaining - take;
      const mask = (1 << take) - 1;
      value = (value << take | this.word >> shift & mask) >>> 0;
      this.bitsRemaining -= take;
      remaining -= take;
    }
    return value;
  }
  readBit() {
    if (this.bitsRemaining === 0) this.loadWord();
    this.bitsRemaining--;
    return this.word >> this.bitsRemaining & 1;
  }
  alignToWord() {
    this.bitsRemaining = 0;
  }
  readRawByte() {
    this.ensureByteAligned();
    this.ensureRawBytes(1);
    return this.data[this.nextWordOffset++];
  }
  readRawUInt32() {
    this.ensureByteAligned();
    this.ensureRawBytes(4);
    const value = (this.data[this.nextWordOffset] | this.data[this.nextWordOffset + 1] << 8 | this.data[this.nextWordOffset + 2] << 16 | this.data[this.nextWordOffset + 3] << 24) >>> 0;
    this.nextWordOffset += 4;
    return value;
  }
  copyRawBytes(destination, destinationOffset, count) {
    this.ensureByteAligned();
    this.ensureRawBytes(count);
    destination.set(this.data.subarray(this.nextWordOffset, this.nextWordOffset + count), destinationOffset);
    this.nextWordOffset += count;
  }
  loadWord() {
    if (this.nextWordOffset > this.data.length - 2) {
      throw new OneNoteFormatError("ONENOTE_CAB_LZX_TRUNCATED", "The CAB LZX bitstream ended inside a 16-bit word.");
    }
    this.word = this.data[this.nextWordOffset] | this.data[this.nextWordOffset + 1] << 8;
    this.nextWordOffset += 2;
    this.bitsRemaining = 16;
  }
  ensureByteAligned() {
    if (this.bitsRemaining !== 0) {
      throw corrupt("The CAB LZX stream entered byte mode without word alignment.");
    }
  }
  ensureRawBytes(count) {
    if (count < 0 || this.nextWordOffset > this.data.length - count) {
      throw new OneNoteFormatError("ONENOTE_CAB_LZX_TRUNCATED", "The CAB LZX byte stream ended unexpectedly.");
    }
  }
};
var HuffmanTree = class _HuffmanTree {
  constructor(counts, firstCodes, firstSymbolIndexes, symbols) {
    this.counts = counts;
    this.firstCodes = firstCodes;
    this.firstSymbolIndexes = firstSymbolIndexes;
    this.symbols = symbols;
  }
  static empty = new _HuffmanTree(
    new Int32Array(MAXIMUM_PATH_LENGTH + 1),
    new Int32Array(MAXIMUM_PATH_LENGTH + 1),
    new Int32Array(MAXIMUM_PATH_LENGTH + 1),
    new Int32Array(0)
  );
  static create(pathLengths, allowEmpty, treeName) {
    const counts = new Int32Array(MAXIMUM_PATH_LENGTH + 1);
    for (const length of pathLengths) {
      if (length > MAXIMUM_PATH_LENGTH) throw corrupt(`${treeName} tree contains an invalid path length.`);
      if (length !== 0) counts[length]++;
    }
    let symbolCount = 0;
    for (const count of counts) symbolCount += count;
    if (symbolCount === 0) {
      if (allowEmpty) return _HuffmanTree.empty;
      throw corrupt(`${treeName} tree is empty.`);
    }
    if (symbolCount === 1) throw corrupt(`${treeName} tree contains only one symbol.`);
    const firstCodes = new Int32Array(MAXIMUM_PATH_LENGTH + 1);
    const firstSymbolIndexes = new Int32Array(MAXIMUM_PATH_LENGTH + 1);
    let code = 0;
    let symbolIndex = 0;
    for (let length = 1; length <= MAXIMUM_PATH_LENGTH; length++) {
      code = code + counts[length - 1] << 1;
      firstCodes[length] = code;
      firstSymbolIndexes[length] = symbolIndex;
      if (code + counts[length] > 1 << length) throw corrupt(`${treeName} tree is oversubscribed.`);
      symbolIndex += counts[length];
    }
    const symbols = new Int32Array(symbolCount);
    const nextIndexes = firstSymbolIndexes.slice();
    for (let symbol = 0; symbol < pathLengths.length; symbol++) {
      const length = pathLengths[symbol];
      if (length !== 0) symbols[nextIndexes[length]++] = symbol;
    }
    return new _HuffmanTree(counts, firstCodes, firstSymbolIndexes, symbols);
  }
  decode(reader) {
    if (this.symbols.length === 0) throw corrupt("The LZX stream uses an empty Huffman tree.");
    let code = 0;
    for (let length = 1; length <= MAXIMUM_PATH_LENGTH; length++) {
      code = code << 1 | reader.readBit();
      const offset = code - this.firstCodes[length];
      if (offset >= 0 && offset < this.counts[length]) {
        return this.symbols[this.firstSymbolIndexes[length] + offset];
      }
    }
    throw corrupt("The LZX stream contains a Huffman code that is absent from its tree.");
  }
};
var LzxDecoder = class {
  windowSize;
  positionBase;
  positionFooterBits;
  mainPathLengths;
  lengthPathLengths = new Uint8Array(LENGTH_TREE_SYMBOLS);
  decoded;
  mainTree = HuffmanTree.empty;
  lengthTree = HuffmanTree.empty;
  alignedTree = HuffmanTree.empty;
  recentOffset0 = 1;
  recentOffset1 = 1;
  recentOffset2 = 1;
  outputOffset = 0;
  blockType = 0;
  blockBytesRemaining = 0;
  streamHeaderRead = false;
  translationFileSize = 0;
  uncompressedBlockNeedsPadding = false;
  uncompressedPaddingPending = false;
  constructor(outputLength, windowBits) {
    if (windowBits < 15 || windowBits > 21) {
      throw new OneNoteFormatError("ONENOTE_CAB_LZX_WINDOW", "The CAB uses an unsupported LZX window size.");
    }
    this.windowSize = 1 << windowBits;
    const bases = [];
    const bits = [];
    for (let slot = 0, nextBase = 0; nextBase < this.windowSize; slot++) {
      const footerBits = slot < 4 ? 0 : slot < 36 ? (slot >> 1) - 1 : 17;
      bases.push(nextBase);
      bits.push(footerBits);
      nextBase += 1 << footerBits;
    }
    this.positionBase = Int32Array.from(bases);
    this.positionFooterBits = Int32Array.from(bits);
    this.mainPathLengths = new Uint8Array(LITERAL_SYMBOLS + PRIMARY_LENGTH_SYMBOLS * this.positionBase.length);
    this.decoded = new Uint8Array(outputLength);
  }
  decode(chunks, sizes, requiredBytes) {
    const frameStarts = new Int32Array(sizes.length);
    let frames = 0;
    while (frames < chunks.length && this.outputOffset < requiredBytes) {
      frameStarts[frames] = this.outputOffset;
      this.decodeFrame(chunks[frames], sizes[frames]);
      frames++;
    }
    const complete = frames === chunks.length;
    if (complete && (this.outputOffset !== this.decoded.length || this.blockBytesRemaining !== 0)) {
      throw corrupt("The LZX stream does not describe the expected expanded size.");
    }
    if (this.translationFileSize > 0) {
      for (let frame = 0; frame < frames && frame < MAXIMUM_TRANSLATED_FRAMES; frame++) {
        reverseE8Translation(this.decoded, frameStarts[frame], sizes[frame], this.translationFileSize);
      }
    }
    return this.decoded;
  }
  decodeFrame(chunk, expandedSize) {
    const frameEnd = this.outputOffset + expandedSize;
    const reader = new BitReader(chunk);
    if (this.uncompressedPaddingPending) {
      if (reader.remainingByteCount < 1) {
        throw new OneNoteFormatError("ONENOTE_CAB_LZX_TRUNCATED", "The LZX uncompressed-block padding byte is missing.");
      }
      reader.readRawByte();
      this.uncompressedPaddingPending = false;
    }
    while (this.outputOffset < frameEnd) {
      if (this.blockBytesRemaining === 0) this.readBlockHeader(reader);
      if (this.blockType === UNCOMPRESSED_BLOCK) this.decodeUncompressedSlice(reader, frameEnd);
      else this.decodeCompressedSlice(reader, frameEnd);
      if (this.blockBytesRemaining === 0 && this.blockType === UNCOMPRESSED_BLOCK) {
        this.consumeUncompressedPadding(reader);
      }
    }
    if (this.outputOffset !== frameEnd) {
      throw corrupt("An LZX token crosses a 32-KB CFDATA output boundary.");
    }
  }
  readBlockHeader(reader) {
    if (!this.streamHeaderRead) {
      this.streamHeaderRead = true;
      if (reader.readBits(1) !== 0) {
        const high = reader.readBits(16);
        const low = reader.readBits(16);
        this.translationFileSize = (high << 16 | low) >>> 0;
        if (this.translationFileSize > 2147483647) {
          throw corrupt("The LZX E8 translation size is outside the supported range.");
        }
      }
    }
    this.blockType = reader.readBits(3);
    this.blockBytesRemaining = reader.readBits(16) << 8 | reader.readBits(8);
    if (this.blockBytesRemaining === 0 || this.blockType !== VERBATIM_BLOCK && this.blockType !== ALIGNED_OFFSET_BLOCK && this.blockType !== UNCOMPRESSED_BLOCK) {
      throw corrupt("The LZX block header contains an invalid type or size.");
    }
    if (this.blockType === UNCOMPRESSED_BLOCK) {
      this.uncompressedBlockNeedsPadding = (this.blockBytesRemaining & 1) !== 0;
      reader.alignToWord();
      this.recentOffset0 = reader.readRawUInt32();
      this.recentOffset1 = reader.readRawUInt32();
      this.recentOffset2 = reader.readRawUInt32();
      this.validateRepeatedOffset(this.recentOffset0);
      this.validateRepeatedOffset(this.recentOffset1);
      this.validateRepeatedOffset(this.recentOffset2);
      return;
    }
    if (this.blockType === ALIGNED_OFFSET_BLOCK) {
      const alignedLengths = new Uint8Array(ALIGNED_TREE_SYMBOLS);
      for (let index = 0; index < alignedLengths.length; index++) alignedLengths[index] = reader.readBits(3);
      this.alignedTree = HuffmanTree.create(alignedLengths, false, "aligned-offset");
    }
    readPathLengths(reader, this.mainPathLengths, 0, LITERAL_SYMBOLS);
    readPathLengths(reader, this.mainPathLengths, LITERAL_SYMBOLS, this.mainPathLengths.length);
    this.mainTree = HuffmanTree.create(this.mainPathLengths, false, "main");
    readPathLengths(reader, this.lengthPathLengths, 0, this.lengthPathLengths.length);
    this.lengthTree = HuffmanTree.create(this.lengthPathLengths, true, "length");
  }
  decodeUncompressedSlice(reader, frameEnd) {
    const copyLength = Math.min(this.blockBytesRemaining, frameEnd - this.outputOffset);
    reader.copyRawBytes(this.decoded, this.outputOffset, copyLength);
    this.outputOffset += copyLength;
    this.blockBytesRemaining -= copyLength;
  }
  decodeCompressedSlice(reader, frameEnd) {
    while (this.blockBytesRemaining > 0 && this.outputOffset < frameEnd) {
      const symbol = this.mainTree.decode(reader);
      if (symbol < LITERAL_SYMBOLS) {
        this.decoded[this.outputOffset++] = symbol;
        this.blockBytesRemaining--;
        continue;
      }
      const matchHeader = symbol - LITERAL_SYMBOLS;
      const positionSlot = matchHeader >> 3;
      const lengthHeader = matchHeader & 7;
      if (positionSlot >= this.positionBase.length) {
        throw corrupt("The LZX match references an invalid position slot.");
      }
      let matchLength = lengthHeader + 2;
      if (lengthHeader === 7) matchLength += this.lengthTree.decode(reader);
      const matchOffset = this.decodeMatchOffset(reader, positionSlot);
      if (matchLength > this.blockBytesRemaining || matchLength > frameEnd - this.outputOffset) {
        throw corrupt("An LZX match crosses a block or CFDATA output boundary.");
      }
      if (matchOffset === 0 || matchOffset > this.windowSize || matchOffset > this.outputOffset) {
        throw corrupt("An LZX match references bytes outside the available window.");
      }
      const source = this.outputOffset - matchOffset;
      if (matchOffset >= matchLength && matchLength >= 16) {
        this.decoded.copyWithin(this.outputOffset, source, source + matchLength);
        this.outputOffset += matchLength;
      } else {
        for (let index = 0; index < matchLength; index++) {
          this.decoded[this.outputOffset++] = this.decoded[source + index];
        }
      }
      this.blockBytesRemaining -= matchLength;
    }
  }
  decodeMatchOffset(reader, positionSlot) {
    if (positionSlot === 0) return this.recentOffset0;
    if (positionSlot === 1) {
      const offset = this.recentOffset1;
      this.recentOffset1 = this.recentOffset0;
      this.recentOffset0 = offset;
      return offset;
    }
    if (positionSlot === 2) {
      const offset = this.recentOffset2;
      this.recentOffset2 = this.recentOffset0;
      this.recentOffset0 = offset;
      return offset;
    }
    const footerBits = this.positionFooterBits[positionSlot];
    let footer;
    if (this.blockType === ALIGNED_OFFSET_BLOCK && footerBits >= 3) {
      const high = footerBits === 3 ? 0 : reader.readBits(footerBits - 3) << 3;
      footer = high | this.alignedTree.decode(reader);
    } else {
      footer = reader.readBits(footerBits);
    }
    const formattedOffset = this.positionBase[positionSlot] + footer;
    if (formattedOffset < 3) throw corrupt("The LZX match contains an invalid formatted offset.");
    const matchOffset = formattedOffset - 2;
    this.validateRepeatedOffset(matchOffset);
    this.recentOffset2 = this.recentOffset1;
    this.recentOffset1 = this.recentOffset0;
    this.recentOffset0 = matchOffset;
    return matchOffset;
  }
  consumeUncompressedPadding(reader) {
    if (!this.uncompressedBlockNeedsPadding) return;
    this.uncompressedBlockNeedsPadding = false;
    if (reader.remainingByteCount > 0) reader.readRawByte();
    else this.uncompressedPaddingPending = true;
  }
  validateRepeatedOffset(offset) {
    if (offset === 0 || offset > this.windowSize) {
      throw corrupt("The LZX repeated-offset state is outside the configured window.");
    }
  }
};
function readPathLengths(reader, lengths, start, end) {
  const pretreeLengths = new Uint8Array(PRETREE_SYMBOLS);
  for (let index = 0; index < pretreeLengths.length; index++) pretreeLengths[index] = reader.readBits(4);
  const pretree = HuffmanTree.create(pretreeLengths, false, "pretree");
  let cursor = start;
  while (cursor < end) {
    const code = pretree.decode(reader);
    if (code <= MAXIMUM_PATH_LENGTH) {
      lengths[cursor] = (lengths[cursor] - code + 17) % 17;
      cursor++;
      continue;
    }
    let repeat;
    let value;
    if (code === 17) {
      repeat = reader.readBits(4) + 4;
      value = 0;
    } else if (code === 18) {
      repeat = reader.readBits(5) + 20;
      value = 0;
    } else if (code === 19) {
      repeat = reader.readBits(1) + 4;
      const delta = pretree.decode(reader);
      if (delta > MAXIMUM_PATH_LENGTH) throw corrupt("The LZX path-length repeat contains an invalid delta.");
      value = (lengths[cursor] - delta + 17) % 17;
    } else {
      throw corrupt("The LZX pretree contains an invalid symbol.");
    }
    if (repeat > end - cursor) throw corrupt("The LZX path-length repeat exceeds its target tree.");
    for (let index = 0; index < repeat; index++) lengths[cursor++] = value;
  }
}
function reverseE8Translation(data, frameOffset, frameLength, fileSize) {
  if (frameOffset >= 1073741824 || frameLength <= 10) return;
  const scanEnd = frameOffset + frameLength - 10;
  for (let cursor = frameOffset; cursor < scanEnd; cursor++) {
    if (data[cursor] !== 232) continue;
    const value = data[cursor + 1] | data[cursor + 2] << 8 | data[cursor + 3] << 16 | data[cursor + 4] << 24;
    if (value >= -cursor && value < fileSize) {
      const displacement = value >= 0 ? value - cursor : value + fileSize;
      data[cursor + 1] = displacement;
      data[cursor + 2] = displacement >> 8;
      data[cursor + 3] = displacement >> 16;
      data[cursor + 4] = displacement >> 24;
    }
    cursor += 4;
  }
}
function lzxDecompress(chunks, sizes, windowBits, maxOutputBytes, requiredBytes) {
  if (chunks.length !== sizes.length) {
    throw new OneNoteFormatError("ONENOTE_CAB_LZX_BLOCKS", "CAB LZX block metadata is inconsistent.");
  }
  let outputLength = 0;
  for (let index = 0; index < sizes.length; index++) {
    if (sizes[index] < 0 || outputLength > maxOutputBytes - sizes[index]) {
      throw new OneNoteFormatError("ONENOTE_CAB_EXPANDED_LIMIT", "The expanded CAB folder exceeds the configured size limit.");
    }
    outputLength += sizes[index];
  }
  return new LzxDecoder(outputLength, windowBits).decode(chunks, sizes, requiredBytes ?? outputLength);
}

// src/onenote-file/cabinet/cabinet.ts
var COMPRESSION_NONE = 0;
var COMPRESSION_MSZIP = 1;
var COMPRESSION_LZX = 3;
var COMPRESSION_MASK = 15;
var FLAG_PREVIOUS_CABINET = 1;
var FLAG_NEXT_CABINET = 2;
var FLAG_RESERVE_PRESENT = 4;
var UTF_NAME_ATTRIBUTE = 128;
var DEFAULT_CABINET_LIMITS = {
  maxExpandedBytes: 2 * 1024 * 1024 * 1024,
  maxEntryBytes: 512 * 1024 * 1024,
  maxEntries: 4096
};
function cabinetChecksum(data, offset, count) {
  let checksum = 0;
  const end = offset + count;
  while (offset <= end - 4) {
    checksum ^= data[offset] | data[offset + 1] << 8 | data[offset + 2] << 16 | data[offset + 3] << 24;
    offset += 4;
  }
  let remainder = 0;
  while (offset < end) remainder = remainder << 8 | data[offset++];
  return (checksum ^ remainder) >>> 0;
}
function ensure(data, offset, length, structure) {
  if (offset < 0 || length < 0 || offset > data.length - length) {
    throw new OneNoteFormatError("ONENOTE_CAB_TRUNCATED", `The .onepkg archive ended inside ${structure}.`, offset);
  }
}
function readUInt16(data, offset) {
  ensure(data, offset, 2, "integer");
  return data[offset] | data[offset + 1] << 8;
}
function readUInt32(data, offset) {
  ensure(data, offset, 4, "integer");
  return (data[offset] | data[offset + 1] << 8 | data[offset + 2] << 16 | data[offset + 3] << 24) >>> 0;
}
function readCString(data, offset, utf8) {
  let end = offset;
  while (end < data.length && data[end] !== 0) end++;
  if (end >= data.length) throw new OneNoteFormatError("ONENOTE_CAB_STRING", "A CAB string is not null-terminated.", offset);
  const bytes = data.subarray(offset, end);
  const value = utf8 ? new TextDecoder().decode(bytes) : String.fromCharCode(...bytes);
  return { value, nextOffset: end + 1 };
}
function decompressFolder(cabinet, folder, dataReserve, maxExpandedBytes, requiredBytes) {
  let offset = folder.dataOffset;
  const blocks = [];
  const sizes = [];
  let total = 0;
  for (let index = 0; index < folder.blockCount; index++) {
    ensure(cabinet, offset, 8, "CFDATA");
    const declaredChecksum = readUInt32(cabinet, offset);
    const compressedLength = readUInt16(cabinet, offset + 4);
    const expandedLength = readUInt16(cabinet, offset + 6);
    const dataOffset = offset + 8 + dataReserve;
    ensure(cabinet, dataOffset, compressedLength, "CFDATA payload");
    if (declaredChecksum !== 0 && total < requiredBytes) {
      const actual = cabinetChecksum(cabinet, offset + 4, 4 + dataReserve + compressedLength);
      if (actual !== declaredChecksum) {
        throw new OneNoteFormatError("ONENOTE_CAB_CHECKSUM", "A CAB data block has an invalid checksum.", offset);
      }
    }
    blocks.push(cabinet.subarray(dataOffset, dataOffset + compressedLength));
    sizes.push(expandedLength);
    total += expandedLength;
    if (total > maxExpandedBytes) {
      throw new OneNoteFormatError("ONENOTE_CAB_EXPANDED_LIMIT", "The expanded CAB folder exceeds the configured size limit.");
    }
    offset = dataOffset + compressedLength;
  }
  switch (folder.compression & COMPRESSION_MASK) {
    case COMPRESSION_NONE: {
      const output = new Uint8Array(total);
      let outputOffset = 0;
      for (let index = 0; index < blocks.length; index++) {
        if (blocks[index].length !== sizes[index]) {
          throw new OneNoteFormatError("ONENOTE_CAB_UNCOMPRESSED", "An uncompressed CAB block has inconsistent sizes.");
        }
        output.set(blocks[index], outputOffset);
        outputOffset += blocks[index].length;
      }
      return output;
    }
    case COMPRESSION_LZX:
      return lzxDecompress(blocks, sizes, folder.compression >> 8 & 31, maxExpandedBytes, requiredBytes);
    case COMPRESSION_MSZIP:
      throw new OneNoteFormatError("ONENOTE_CAB_MSZIP", "MSZIP-compressed .onepkg archives are not supported yet.");
    default:
      throw new OneNoteFormatError("ONENOTE_CAB_COMPRESSION", "The .onepkg CAB uses an unsupported compression method.");
  }
}
function readLayout(data, limits) {
  if (data.length < 36 || data[0] !== 77 || data[1] !== 83 || data[2] !== 67 || data[3] !== 70) {
    throw new OneNoteFormatError("ONENOTE_CAB_SIGNATURE", "The .onepkg file is not a Microsoft Cabinet archive.");
  }
  const declaredSize = readUInt32(data, 8);
  const filesOffset = readUInt32(data, 16);
  const folderCount = readUInt16(data, 26);
  const fileCount = readUInt16(data, 28);
  const flags = readUInt16(data, 30);
  if (declaredSize > data.length || folderCount < 1 || fileCount > limits.maxEntries) {
    throw new OneNoteFormatError("ONENOTE_CAB_HEADER", "The CAB header contains invalid sizes or entry counts.");
  }
  let offset = 36;
  let folderReserve = 0;
  let dataReserve = 0;
  if ((flags & FLAG_RESERVE_PRESENT) !== 0) {
    ensure(data, offset, 4, "CAB reserve header");
    const headerReserve = readUInt16(data, offset);
    folderReserve = data[offset + 2];
    dataReserve = data[offset + 3];
    offset += 4 + headerReserve;
    ensure(data, offset, 0, "CAB reserve header");
  }
  if ((flags & FLAG_PREVIOUS_CABINET) !== 0) {
    offset = readCString(data, offset, false).nextOffset;
    offset = readCString(data, offset, false).nextOffset;
  }
  if ((flags & FLAG_NEXT_CABINET) !== 0) {
    offset = readCString(data, offset, false).nextOffset;
    offset = readCString(data, offset, false).nextOffset;
  }
  const folders = [];
  for (let index = 0; index < folderCount; index++) {
    ensure(data, offset, 8, "CFFOLDER");
    folders.push({
      dataOffset: readUInt32(data, offset),
      blockCount: readUInt16(data, offset + 4),
      compression: readUInt16(data, offset + 6)
    });
    offset += 8 + folderReserve;
  }
  offset = filesOffset;
  const files = [];
  for (let index = 0; index < fileCount; index++) {
    ensure(data, offset, 16, "CFFILE");
    const length = readUInt32(data, offset);
    const folderOffset = readUInt32(data, offset + 4);
    const folderIndex = readUInt16(data, offset + 8);
    const attributes = readUInt16(data, offset + 14);
    const { value: name, nextOffset } = readCString(data, offset + 16, (attributes & UTF_NAME_ATTRIBUTE) !== 0);
    if (length > limits.maxEntryBytes) {
      throw new OneNoteFormatError("ONENOTE_CAB_ENTRY_LIMIT", "A .onepkg entry exceeds the configured size limit.");
    }
    files.push({ length, folderOffset, folderIndex, name });
    offset = nextOffset;
  }
  return { folders, files, dataReserve };
}
function readCabinetIndex(data, limits = DEFAULT_CABINET_LIMITS) {
  const { files } = readLayout(data, limits);
  return {
    entries: files.map((file) => ({
      name: file.name,
      length: file.length,
      folderIndex: file.folderIndex,
      folderOffset: file.folderOffset
    }))
  };
}
function readCabinet(data, limits = DEFAULT_CABINET_LIMITS, wanted) {
  const { folders, files, dataReserve } = readLayout(data, limits);
  const selected = wanted ? files.filter((file) => wanted(file.name)) : files;
  const requiredBytes = new Array(folders.length).fill(0);
  for (const file of selected) {
    if (file.folderIndex >= folders.length) {
      throw new OneNoteFormatError("ONENOTE_CAB_FOLDER", "A .onepkg entry references a missing or continued CAB folder.");
    }
    requiredBytes[file.folderIndex] = Math.max(requiredBytes[file.folderIndex], file.folderOffset + file.length);
  }
  const folderData = [];
  let totalExpanded = 0;
  for (let index = 0; index < folders.length; index++) {
    if (requiredBytes[index] === 0) {
      folderData.push(void 0);
      continue;
    }
    const expanded = decompressFolder(data, folders[index], dataReserve, limits.maxExpandedBytes - totalExpanded, requiredBytes[index]);
    totalExpanded += expanded.length;
    if (totalExpanded > limits.maxExpandedBytes) {
      throw new OneNoteFormatError("ONENOTE_CAB_EXPANDED_LIMIT", "The expanded .onepkg archive exceeds the configured size limit.");
    }
    folderData.push(expanded);
  }
  const entries = [];
  let totalExtractedBytes = 0;
  for (const file of selected) {
    const source = folderData[file.folderIndex];
    if (!source || file.folderOffset > source.length || file.folderOffset + file.length > source.length) {
      throw new OneNoteFormatError("ONENOTE_CAB_ENTRY_RANGE", "A .onepkg entry extends past its CAB folder.");
    }
    if (file.length > limits.maxExpandedBytes - totalExtractedBytes) {
      throw new OneNoteFormatError("ONENOTE_CAB_EXPANDED_LIMIT", "The extracted .onepkg entries exceed the configured size limit.");
    }
    totalExtractedBytes += file.length;
    entries.push({ name: file.name, data: source.subarray(file.folderOffset, file.folderOffset + file.length) });
  }
  return entries;
}

// src/onenote-file/onestore/binary.ts
function ensureRange(data, offset, length) {
  if (offset < 0 || length < 0 || offset > data.length - length) {
    throw new OneNoteFormatError(
      "ONENOTE_TRUNCATED_STRUCTURE",
      "The OneNote file ended before a required structure could be read.",
      offset
    );
  }
}
function readUInt162(data, offset) {
  ensureRange(data, offset, 2);
  return data[offset] | data[offset + 1] << 8;
}
function readUInt322(data, offset) {
  ensureRange(data, offset, 4);
  return (data[offset] | data[offset + 1] << 8 | data[offset + 2] << 16 | data[offset + 3] << 24) >>> 0;
}
function readUInt64(data, offset) {
  const low = readUInt322(data, offset);
  const high = readUInt322(data, offset + 4);
  if (high > 2097151) {
    throw new OneNoteFormatError("ONENOTE_OFFSET_RANGE", "A OneNote file offset exceeds the supported range.", offset);
  }
  return high * 4294967296 + low;
}
function isAllOnes(data, offset, length) {
  ensureRange(data, offset, length);
  for (let index = 0; index < length; index++) {
    if (data[offset + index] !== 255) return false;
  }
  return true;
}
function readUnsigned(data, offset, length) {
  ensureRange(data, offset, length);
  let value = 0;
  for (let index = length - 1; index >= 0; index--) {
    if (value > Number.MAX_SAFE_INTEGER / 256) {
      throw new OneNoteFormatError("ONENOTE_OFFSET_RANGE", "A OneNote file offset exceeds the supported range.", offset);
    }
    value = value * 256 + data[offset + index];
  }
  return value;
}
function bytesEqual(data, offset, expected) {
  ensureRange(data, offset, expected.length);
  for (let index = 0; index < expected.length; index++) {
    if (data[offset + index] !== expected[index]) return false;
  }
  return true;
}
function readGuid(data, offset) {
  ensureRange(data, offset, 16);
  const hex = (index) => data[offset + index].toString(16).padStart(2, "0");
  return [
    hex(3) + hex(2) + hex(1) + hex(0),
    hex(5) + hex(4),
    hex(7) + hex(6),
    hex(8) + hex(9),
    hex(10) + hex(11) + hex(12) + hex(13) + hex(14) + hex(15)
  ].join("-");
}
var EMPTY_GUID = "00000000-0000-0000-0000-000000000000";
function readFileChunkReference64x32(data, offset) {
  const length = readUInt322(data, offset + 8);
  if (isAllOnes(data, offset, 8) && length === 0) {
    return { offset: 0, length: 0, isNil: true };
  }
  return { offset: readUInt64(data, offset), length, isNil: false };
}
function isZeroReference(reference) {
  return !reference.isNil && reference.offset === 0 && reference.length === 0;
}

// src/onenote-file/onex.ts
var SIGNATURE = [208, 207, 17, 224, 161, 177, 26, 225];
var DIRECTORY_ENTRY_LENGTH = 128;
var MAX_DIRECTORY_SECTORS = 4096;
function isCompoundFile(data) {
  if (data.length < SIGNATURE.length) return false;
  return SIGNATURE.every((byte, index) => data[index] === byte);
}
function inspectOnex(data) {
  if (!isCompoundFile(data)) {
    throw new OneNoteFormatError("ONENOTE_ONEX_SIGNATURE", "The .onex file is not an OLE compound file.");
  }
  const sectorSize = 1 << readUInt162(data, 30);
  const fatSectorCount = readUInt322(data, 44);
  const firstDirectorySector = readUInt322(data, 48);
  const fat = [];
  for (let index = 0; index < Math.min(fatSectorCount, 109); index++) {
    const sector2 = readUInt322(data, 76 + index * 4);
    const base = (sector2 + 1) * sectorSize;
    if (base + sectorSize > data.length) break;
    for (let offset = 0; offset < sectorSize; offset += 4) fat.push(readUInt322(data, base + offset));
  }
  const streams = [];
  const seen = /* @__PURE__ */ new Set();
  let sector = firstDirectorySector;
  while (sector < 4294967290 && !seen.has(sector) && seen.size < MAX_DIRECTORY_SECTORS) {
    seen.add(sector);
    const base = (sector + 1) * sectorSize;
    if (base + sectorSize > data.length) break;
    for (let offset = 0; offset < sectorSize; offset += DIRECTORY_ENTRY_LENGTH) {
      const nameLength = readUInt162(data, base + offset + 64);
      if (nameLength < 2 || data[base + offset + 66] === 0) continue;
      streams.push(new TextDecoder("utf-16le").decode(data.subarray(base + offset, base + offset + nameLength - 2)));
    }
    sector = fat[sector] ?? 4294967294;
  }
  const protectedBy = ["EncryptedPackage", "DRMEncryptedTransform", "DRMEncryptedDataSpace"];
  return streams.some((name) => protectedBy.includes(name)) ? "rights-protected" : "unrecognised";
}

// src/onenote-file/onestore/constants.ts
var REVISION_STORE_HEADER_LENGTH = 1024;
var PACKAGE_STORE_FIXED_PREFIX_LENGTH = 72;
var SECTION_FILE_TYPE = "7b5c52e4-d88c-4da7-aeb1-5378d02996d3";
var TABLE_OF_CONTENTS_FILE_TYPE = "43ff2fa1-efd9-4c76-9ee2-10ea5722765f";
var REVISION_STORE_FORMAT = "109add3f-911b-49f5-a5d0-1791edc8aed8";
var PACKAGE_STORE_FORMAT = "638de92f-a6d4-4bc1-9a36-b3fc2511a5b7";
var SECTION_CELL_SCHEMA = "1f937cb4-b26f-445f-b9f8-17e20160e461";
var TABLE_OF_CONTENTS_CELL_SCHEMA = "e4dbfd38-e5c7-408b-a8a1-0e7b421e1f5f";
var FileNodeId = {
  objectSpaceManifestRoot: 4,
  objectSpaceManifestListReference: 8,
  objectSpaceManifestListStart: 12,
  revisionManifestListReference: 16,
  revisionManifestListStart: 20,
  revisionManifestStart4: 27,
  revisionManifestEnd: 28,
  revisionManifestStart6: 30,
  revisionManifestStart7: 31,
  globalIdTableStart: 33,
  globalIdTableStart2: 34,
  globalIdTableEntry: 36,
  globalIdTableEntry2: 37,
  globalIdTableEntry3: 38,
  globalIdTableEnd: 40,
  objectDeclarationWithRefCount: 45,
  objectDeclarationWithRefCount2: 46,
  objectRevisionWithRefCount: 65,
  objectRevisionWithRefCount2: 66,
  rootObjectReference2: 89,
  rootObjectReference3: 90,
  revisionRoleDeclaration: 92,
  revisionRoleAndContextDeclaration: 93,
  objectDeclarationFileData3RefCount: 114,
  objectDeclarationFileData3LargeRefCount: 115,
  objectDataEncryptionKeyV2: 124,
  objectInfoDependencyOverrides: 132,
  dataSignatureGroupDefinition: 140,
  fileDataStoreListReference: 144,
  fileDataStoreObjectReference: 148,
  objectDeclaration2RefCount: 164,
  objectDeclaration2LargeRefCount: 165,
  objectGroupListReference: 176,
  objectGroupStart: 180,
  objectGroupEnd: 184,
  readOnlyObjectDeclaration2RefCount: 196,
  readOnlyObjectDeclaration2LargeRefCount: 197,
  chunkTerminator: 255
};
var FILE_NODE_LIST_HEADER_MAGIC = [196, 244, 247, 245, 177, 122, 86, 164];
var FILE_NODE_LIST_FOOTER_MAGIC = [75, 186, 51, 130, 195, 21, 194, 139];

// src/onenote-file/onestore/file-header.ts
function readExtendedGuid(data, offset) {
  ensureRange(data, offset, 1);
  const first = data[offset];
  if (first === 0) return { identifier: EMPTY_GUID, value: 0, encodedLength: 1 };
  if ((first & 7) === 4) {
    ensureRange(data, offset, 17);
    return { identifier: readGuid(data, offset + 1), value: first >> 3, encodedLength: 17 };
  }
  const firstTwo = readUInt162(data, offset);
  if ((firstTwo & 63) === 32) {
    ensureRange(data, offset, 18);
    return { identifier: readGuid(data, offset + 2), value: firstTwo >> 6, encodedLength: 18 };
  }
  ensureRange(data, offset, 3);
  const firstThree = data[offset] | data[offset + 1] << 8 | data[offset + 2] << 16;
  if ((firstThree & 127) === 64) {
    ensureRange(data, offset, 19);
    return { identifier: readGuid(data, offset + 3), value: firstThree >>> 7, encodedLength: 19 };
  }
  if (first === 128) {
    ensureRange(data, offset, 21);
    return { identifier: readGuid(data, offset + 5), value: readUInt322(data, offset + 1), encodedLength: 21 };
  }
  throw new OneNoteFormatError(
    "ONENOTE_FSSHTTP_EXTENDED_GUID",
    "The package contains an invalid MS-FSSHTTPB extended GUID encoding.",
    offset
  );
}
function readFileHeader(data, actualFileLength, options) {
  if (data.length >= 4 && data[0] === 77 && data[1] === 83 && data[2] === 67 && data[3] === 70) {
    return {
      fileKind: "notebook-package",
      storageFormat: "notebook-package",
      fileTypeId: EMPTY_GUID,
      fileId: EMPTY_GUID,
      legacyFileVersionId: EMPTY_GUID,
      fileFormatId: EMPTY_GUID,
      actualFileLength,
      diagnostics: []
    };
  }
  ensureRange(data, 0, 64);
  const fileFormat = readGuid(data, 48);
  if (fileFormat === REVISION_STORE_FORMAT) return readRevisionStoreHeader(data, actualFileLength, options);
  if (fileFormat === PACKAGE_STORE_FORMAT) return readPackageStoreHeader(data, actualFileLength, options);
  throw new OneNoteFormatError(
    "ONENOTE_UNKNOWN_FILE_FORMAT",
    "The file does not contain a recognized MS-ONESTORE or package-store format identifier.",
    48
  );
}
function readRevisionStoreHeader(data, actualFileLength, options) {
  ensureRange(data, 0, REVISION_STORE_HEADER_LENGTH);
  const fileType = readGuid(data, 0);
  const header = {
    fileKind: resolveDesktopFileKind(fileType),
    storageFormat: "revision-store",
    fileTypeId: fileType,
    fileId: readGuid(data, 16),
    legacyFileVersionId: readGuid(data, 32),
    fileFormatId: readGuid(data, 48),
    actualFileLength,
    transactionCount: readUInt322(data, 96),
    ancestorId: readGuid(data, 128),
    hashedChunkList: readFileChunkReference64x32(data, 148),
    transactionLog: readFileChunkReference64x32(data, 160),
    rootFileNodeList: readFileChunkReference64x32(data, 172),
    freeChunkList: readFileChunkReference64x32(data, 184),
    expectedFileLength: readUInt64(data, 196),
    fileVersionId: readGuid(data, 212),
    fileVersionGeneration: readUInt64(data, 228),
    denyReadFileVersionId: readGuid(data, 236),
    diagnostics: []
  };
  validateRevisionStoreHeader(data, header, options);
  return header;
}
function readPackageStoreHeader(data, actualFileLength, options) {
  ensureRange(data, 0, PACKAGE_STORE_FIXED_PREFIX_LENGTH + 1);
  const fileType = readGuid(data, 0);
  if (fileType !== SECTION_FILE_TYPE) {
    throw new OneNoteFormatError(
      "ONENOTE_PACKAGE_FILE_TYPE",
      "The package-store header does not contain the required OneNote file-type identifier.",
      0
    );
  }
  const streamHeader = readUInt322(data, 68);
  const headerType = streamHeader & 3;
  const compound = (streamHeader & 4) !== 0;
  const streamObjectType = streamHeader >>> 3 & 16383;
  const declaredLength = streamHeader >>> 17;
  if (headerType !== 2 || !compound || streamObjectType !== 122) {
    throw new OneNoteFormatError(
      "ONENOTE_PACKAGE_START",
      "The package-store header does not begin with the required packaging stream object.",
      68
    );
  }
  if (declaredLength === 32767) {
    throw new OneNoteFormatError(
      "ONENOTE_PACKAGE_LARGE_HEADER",
      "A package-store header with a large-length packaging prefix is not valid for the fixed OneNote envelope.",
      68
    );
  }
  const storageIndex = readExtendedGuid(data, 72);
  if (storageIndex.identifier === EMPTY_GUID) {
    throw new OneNoteFormatError(
      "ONENOTE_PACKAGE_STORAGE_INDEX",
      "The package-store storage index identifier cannot be empty.",
      72
    );
  }
  const cellSchema = readGuid(data, 72 + storageIndex.encodedLength);
  const header = {
    fileKind: resolveCellSchemaKind(cellSchema),
    storageFormat: "file-synchronization-package",
    fileTypeId: fileType,
    fileId: readGuid(data, 16),
    legacyFileVersionId: readGuid(data, 32),
    fileFormatId: readGuid(data, 48),
    actualFileLength,
    storageIndexId: storageIndex,
    cellSchemaId: cellSchema,
    diagnostics: []
  };
  if (declaredLength !== storageIndex.encodedLength + 16) {
    reportOrThrow(
      header,
      options,
      "ONENOTE_PACKAGE_PREFIX_LENGTH",
      "The packaging stream object length does not match the storage-index and cell-schema payload.",
      68
    );
  }
  return header;
}
function validateRevisionStoreHeader(data, header, options) {
  const expectedVersion = header.fileKind === "section" ? 42 : 27;
  for (let offset = 64; offset <= 76; offset += 4) {
    if (readUInt322(data, offset) !== expectedVersion) {
      reportOrThrow(
        header,
        options,
        "ONENOTE_FILE_VERSION",
        "The revision-store header contains a file-format version that does not match its file type.",
        offset
      );
    }
  }
  if (header.legacyFileVersionId !== EMPTY_GUID) {
    reportOrThrow(
      header,
      options,
      "ONENOTE_LEGACY_VERSION_GUID",
      "The desktop revision-store legacy file-version identifier is not empty.",
      32
    );
  }
  if (!header.transactionCount) {
    throw new OneNoteFormatError("ONENOTE_TRANSACTION_COUNT", "The revision-store header declares no complete transactions.", 96);
  }
  if (header.expectedFileLength === void 0 || header.expectedFileLength < REVISION_STORE_HEADER_LENGTH) {
    throw new OneNoteFormatError("ONENOTE_EXPECTED_FILE_LENGTH", "The revision-store header declares an invalid expected file length.", 196);
  }
  if (header.actualFileLength !== void 0) {
    if (header.actualFileLength < header.expectedFileLength) {
      throw new OneNoteFormatError(
        "ONENOTE_TRUNCATED_FILE",
        "The source is shorter than the file length declared by its revision-store header.",
        header.actualFileLength
      );
    }
    if (header.actualFileLength > header.expectedFileLength) {
      header.diagnostics.push({
        code: "ONENOTE_TRAILING_DATA",
        message: "The source contains trailing bytes beyond the file length declared by its revision-store header.",
        offset: header.expectedFileLength
      });
    }
  }
  validateRequiredReference(header.transactionLog, "transaction log", 160, header.expectedFileLength);
  validateRequiredReference(header.rootFileNodeList, "root file-node list", 172, header.expectedFileLength);
  validateOptionalReference(header.hashedChunkList, "hashed chunk list", 148, header.expectedFileLength);
  validateOptionalReference(header.freeChunkList, "free chunk list", 184, header.expectedFileLength);
}
function resolveDesktopFileKind(fileType) {
  if (fileType === SECTION_FILE_TYPE) return "section";
  if (fileType === TABLE_OF_CONTENTS_FILE_TYPE) return "table-of-contents";
  throw new OneNoteFormatError("ONENOTE_FILE_TYPE", "The revision-store header contains an unsupported OneNote file-type identifier.", 0);
}
function resolveCellSchemaKind(schema) {
  if (schema === SECTION_CELL_SCHEMA) return "section";
  if (schema === TABLE_OF_CONTENTS_CELL_SCHEMA) return "table-of-contents";
  throw new OneNoteFormatError("ONENOTE_CELL_SCHEMA", "The package-store header contains an unsupported OneNote cell-schema identifier.");
}
function validateRequiredReference(reference, name, offset, expectedFileLength) {
  if (!reference || reference.isNil || isZeroReference(reference) || reference.length === 0) {
    throw new OneNoteFormatError("ONENOTE_REQUIRED_CHUNK_REFERENCE", `The revision-store ${name} reference is missing.`, offset);
  }
  validateReferenceBounds(reference, name, offset, expectedFileLength);
}
function validateOptionalReference(reference, name, offset, expectedFileLength) {
  if (!reference || reference.isNil || isZeroReference(reference)) return;
  validateReferenceBounds(reference, name, offset, expectedFileLength);
}
function validateReferenceBounds(reference, name, offset, expectedFileLength) {
  if (reference.offset > expectedFileLength || reference.length > expectedFileLength - reference.offset) {
    throw new OneNoteFormatError(
      "ONENOTE_CHUNK_REFERENCE_BOUNDS",
      `The revision-store ${name} reference lies outside the declared file length.`,
      offset
    );
  }
}
function reportOrThrow(header, options, code, message, offset) {
  if (options.strictHeaderValidation) throw new OneNoteFormatError(code, message, offset);
  header.diagnostics.push({ code, message, offset });
}

// src/onenote-file/onestore/options.ts
var DEFAULT_READER_OPTIONS = {
  maxFileNodeListFragments: 1e5,
  maxFileNodes: 2e6,
  maxTransactionLogFragments: 1e5,
  maxTransactionEntries: 4e6,
  maxObjects: 1e6,
  maxPropertiesPerObject: 65536,
  maxPropertySetDepth: 128,
  maxPageGraphNodes: 1e5,
  maxInkPathValues: 1e6,
  maxAssetBytes: 64 * 1024 * 1024,
  maxTotalAssetBytes: 256 * 1024 * 1024,
  strictHeaderValidation: true,
  validateTransactionChecksums: true
};

// src/onenote-file/onestore/file-node-list.ts
var FRAGMENT_HEADER_LENGTH = 16;
var FRAGMENT_TRAILER_LENGTH = 20;
var BASE_TYPES = ["inline", "data-reference", "file-node-list-reference"];
function readFileNodeList(file, firstFragment, declaredFileLength, committedNodeCounts, options) {
  const nodes = [];
  const visitedOffsets = /* @__PURE__ */ new Set();
  let current = firstFragment;
  let listId;
  let committedNodeCount = 0;
  let expectedSequence = 0;
  let fragmentCount = 0;
  while (!current.isNil) {
    if (current.offset === 0 && current.length === 0 || current.length < FRAGMENT_HEADER_LENGTH + FRAGMENT_TRAILER_LENGTH) {
      throw new OneNoteFormatError("ONENOTE_FILE_NODE_FRAGMENT_REFERENCE", "A file-node-list fragment reference is empty or too short.", current.offset);
    }
    if (fragmentCount >= options.maxFileNodeListFragments) {
      throw new OneNoteFormatError("ONENOTE_FILE_NODE_FRAGMENT_LIMIT", "The file-node-list fragment limit was exceeded.", current.offset);
    }
    if (visitedOffsets.has(current.offset)) {
      throw new OneNoteFormatError("ONENOTE_FILE_NODE_FRAGMENT_CYCLE", "The file-node-list fragment chain contains a cycle.", current.offset);
    }
    visitedOffsets.add(current.offset);
    validateBounds(current.offset, current.length, declaredFileLength, "file-node-list fragment");
    if (current.offset + current.length > file.length) {
      throw new OneNoteFormatError("ONENOTE_TRUNCATED_STRUCTURE", "The OneNote file ended while reading a referenced structure.", current.offset);
    }
    const data = file.subarray(current.offset, current.offset + current.length);
    if (!bytesEqual(data, 0, FILE_NODE_LIST_HEADER_MAGIC)) {
      throw new OneNoteFormatError("ONENOTE_FILE_NODE_HEADER_MAGIC", "The file-node-list fragment header magic is invalid.", current.offset);
    }
    const currentListId = readUInt322(data, 8);
    const sequence = readUInt322(data, 12);
    if (currentListId < 16) {
      throw new OneNoteFormatError("ONENOTE_FILE_NODE_LIST_ID", "The file-node-list identity is below the minimum valid value.", current.offset + 8);
    }
    if (listId !== void 0 && listId !== currentListId) {
      throw new OneNoteFormatError("ONENOTE_FILE_NODE_LIST_MISMATCH", "A fragment belongs to a different file-node list.", current.offset + 8);
    }
    if (listId === void 0) {
      const count = committedNodeCounts.get(currentListId);
      if (count === void 0) {
        throw new OneNoteFormatError("ONENOTE_TRANSACTION_FILE_NODE_LIST", "The transaction log does not declare the referenced file-node list.", current.offset + 8);
      }
      if (count < 1 || count > options.maxFileNodes) {
        throw new OneNoteFormatError("ONENOTE_TRANSACTION_FILE_NODE_COUNT", "The transaction log declares an invalid file-node count.", current.offset + 8);
      }
      committedNodeCount = count;
    }
    if (sequence !== expectedSequence) {
      throw new OneNoteFormatError("ONENOTE_FILE_NODE_SEQUENCE", "The file-node-list fragment sequence is not contiguous.", current.offset + 12);
    }
    if (!bytesEqual(data, data.length - 8, FILE_NODE_LIST_FOOTER_MAGIC)) {
      throw new OneNoteFormatError("ONENOTE_FILE_NODE_FOOTER_MAGIC", "The file-node-list fragment footer magic is invalid.", current.offset + data.length - 8);
    }
    listId = currentListId;
    fragmentCount++;
    const remainingNodes = committedNodeCount - nodes.length;
    if (remainingNodes <= 0) break;
    const fragmentNodes = readNodes(
      data,
      FRAGMENT_HEADER_LENGTH,
      data.length - FRAGMENT_TRAILER_LENGTH,
      current.offset,
      declaredFileLength,
      options,
      nodes.length,
      remainingNodes
    );
    if (nodes.length > options.maxFileNodes - fragmentNodes.length) {
      throw new OneNoteFormatError("ONENOTE_FILE_NODE_LIMIT", "The file-node limit was exceeded.", current.offset);
    }
    for (const node of fragmentNodes) nodes.push(node);
    current = readFragmentReference(data, data.length - FRAGMENT_TRAILER_LENGTH);
    expectedSequence++;
    if (nodes.length === committedNodeCount) break;
  }
  if (listId === void 0) {
    throw new OneNoteFormatError("ONENOTE_FILE_NODE_LIST_EMPTY", "The file-node list contains no fragments.");
  }
  if (nodes.length !== committedNodeCount) {
    throw new OneNoteFormatError("ONENOTE_FILE_NODE_COUNT", "The file-node list ended before its committed transaction-log count was reached.", firstFragment.offset);
  }
  return { id: listId, nodes };
}
function readFragmentReference(data, offset) {
  const length = readUInt322(data, offset + 8);
  if (isAllOnes(data, offset, 8) && length === 0) return { offset: 0, length: 0, isNil: true };
  return { offset: readUnsigned(data, offset, 8), length, isNil: false };
}
function readNodes(data, start, limit, fragmentOffset, declaredFileLength, options, priorNodeCount, maximumNodes) {
  const nodes = [];
  let offset = start;
  while (limit - offset >= 4 && nodes.length < maximumNodes) {
    if (priorNodeCount + nodes.length >= options.maxFileNodes) {
      throw new OneNoteFormatError("ONENOTE_FILE_NODE_LIMIT", "The file-node limit was exceeded.", fragmentOffset + offset);
    }
    const header = readUInt322(data, offset);
    const id = header & 1023;
    if (id === 0) break;
    const size = header >>> 10 & 8191;
    const stpFormat = header >>> 23 & 3;
    const cbFormat = header >>> 25 & 3;
    const rawBaseType = header >>> 27 & 15;
    if ((header & 2147483648) === 0) {
      throw new OneNoteFormatError("ONENOTE_FILE_NODE_RESERVED_BIT", "The required file-node reserved bit is not set.", fragmentOffset + offset);
    }
    if (size < 4 || size > limit - offset) {
      throw new OneNoteFormatError("ONENOTE_FILE_NODE_SIZE", "The file-node size is invalid or crosses the fragment trailer.", fragmentOffset + offset);
    }
    if (rawBaseType > 2) {
      throw new OneNoteFormatError("ONENOTE_FILE_NODE_BASE_TYPE", "The file-node base type is invalid.", fragmentOffset + offset);
    }
    const baseType = BASE_TYPES[rawBaseType];
    const nodeData = data.subarray(offset + 4, offset + size);
    let chunkReference;
    if (baseType !== "inline") {
      chunkReference = readChunkReference(nodeData, stpFormat, cbFormat, fragmentOffset + offset + 4);
      if (!chunkReference.isNil && (chunkReference.offset !== 0 || chunkReference.length !== 0)) {
        validateBounds(chunkReference.offset, chunkReference.length, declaredFileLength, "file-node chunk reference");
      }
    } else if (cbFormat !== 0) {
      throw new OneNoteFormatError("ONENOTE_INLINE_CB_FORMAT", "An inline file node has a nonzero byte-count format.", fragmentOffset + offset);
    }
    nodes.push({
      id,
      size,
      stpFormat,
      cbFormat,
      baseType,
      fileOffset: fragmentOffset + offset,
      chunkReference,
      data: nodeData
    });
    offset += size;
    if (id === FileNodeId.chunkTerminator) break;
  }
  return nodes;
}
function readChunkReference(data, stpFormat, cbFormat, absoluteOffset) {
  const stpBytes = stpFormat === 0 ? 8 : stpFormat === 2 ? 2 : 4;
  const cbBytes = cbFormat === 0 ? 4 : cbFormat === 1 ? 8 : cbFormat === 2 ? 1 : 2;
  const encodedLength = stpBytes + cbBytes;
  const isNil = isAllOnes(data, 0, stpBytes) && readUnsigned(data, stpBytes, cbBytes) === 0;
  if (isNil) return { offset: 0, length: 0, isNil: true, encodedLength };
  const rawOffset = readUnsigned(data, 0, stpBytes);
  const rawLength = readUnsigned(data, stpBytes, cbBytes);
  return {
    offset: stpFormat >= 2 ? multiplyByEight(rawOffset, absoluteOffset) : rawOffset,
    length: cbFormat >= 2 ? multiplyByEight(rawLength, absoluteOffset + stpBytes) : rawLength,
    isNil: false,
    encodedLength
  };
}
function multiplyByEight(value, offset) {
  if (value > Number.MAX_SAFE_INTEGER / 8) {
    throw new OneNoteFormatError("ONENOTE_COMPRESSED_REFERENCE_OVERFLOW", "A compressed chunk reference overflows its decoded range.", offset);
  }
  return value * 8;
}
function validateBounds(offset, length, fileLength, name) {
  if (offset > fileLength || length > fileLength - offset) {
    throw new OneNoteFormatError("ONENOTE_CHUNK_REFERENCE_BOUNDS", `The ${name} lies outside the declared file length.`, offset);
  }
}

// src/onenote-file/onestore/property-set.ts
var EMPTY_STREAM = { ids: [], extendedStreamsPresent: false, osidStreamNotPresent: true };
var Cursor = class {
  constructor(data, globalIds, options, absoluteOffset) {
    this.data = data;
    this.globalIds = globalIds;
    this.options = options;
    this.absoluteOffset = absoluteOffset;
  }
  position = 0;
  totalProperties = 0;
  error(code, message) {
    return new OneNoteFormatError(code, message, this.absoluteOffset + this.position);
  }
  readReferenceStream() {
    const header = this.readUInt32();
    const count = header & 16777215;
    if ((header & 1056964608) !== 0 || count > this.options.maxObjects) {
      throw this.error("ONENOTE_OBJECT_STREAM_HEADER", "An object-reference stream header is invalid or exceeds the object limit.");
    }
    const ids = [];
    for (let index = 0; index < count; index++) ids.push(this.readCompactId());
    return {
      ids,
      extendedStreamsPresent: (header & 1073741824) !== 0,
      osidStreamNotPresent: (header & 2147483648) !== 0
    };
  }
  readPropertySet(counters, depth) {
    if (depth >= this.options.maxPropertySetDepth) {
      throw this.error("ONENOTE_PROPERTY_DEPTH", "The nested property-set depth limit was exceeded.");
    }
    const start = this.position;
    const count = this.readUInt16();
    if (count > this.options.maxPropertiesPerObject || this.totalProperties > this.options.maxPropertiesPerObject - count) {
      throw this.error("ONENOTE_PROPERTY_LIMIT", "The property count exceeds the configured per-object limit.");
    }
    this.totalProperties += count;
    const rawIds = new Array(count);
    for (let index = 0; index < count; index++) rawIds[index] = this.readUInt32();
    const properties = [];
    for (let index = 0; index < count; index++) {
      const rawId = rawIds[index];
      const property = { rawId, index };
      const type = rawId >>> 26 & 31;
      switch (type) {
        case 1:
          break;
        case 2:
          property.booleanValue = (rawId & 2147483648) !== 0;
          break;
        case 3:
          this.setScalar(property, 1);
          break;
        case 4:
          this.setScalar(property, 2);
          break;
        case 5:
          this.setScalar(property, 4);
          break;
        case 6:
          this.setScalar(property, 8);
          break;
        case 7: {
          const length = this.readUInt32();
          if (length >= 1073741824) {
            throw this.error("ONENOTE_PROPERTY_DATA_LENGTH", "A length-prefixed property value is too large.");
          }
          property.data = this.readBytes(length);
          break;
        }
        case 8:
          property.referencedIds = counters.takeOids(1, this);
          break;
        case 9:
          property.referencedIds = counters.takeOids(this.readReferenceCount(), this);
          break;
        case 10:
          property.referencedIds = counters.takeOsids(1, this);
          break;
        case 11:
          property.referencedIds = counters.takeOsids(this.readReferenceCount(), this);
          break;
        case 12:
          property.referencedIds = counters.takeContexts(1, this);
          break;
        case 13:
          property.referencedIds = counters.takeContexts(this.readReferenceCount(), this);
          break;
        case 16: {
          const childCount = this.readReferenceCount();
          if (childCount === 0) {
            property.childPropertySets = [];
            break;
          }
          const childPropertyId = this.readUInt32();
          if ((childPropertyId >>> 26 & 31) !== 17) {
            throw this.error("ONENOTE_PROPERTY_ARRAY_TYPE", "A property-set array does not declare PropertySet element values.");
          }
          property.childPropertyId = childPropertyId;
          property.childPropertySets = [];
          for (let child = 0; child < childCount; child++) {
            property.childPropertySets.push(this.readPropertySet(counters, depth + 1));
          }
          break;
        }
        case 17:
          property.childPropertySets = [this.readPropertySet(counters, depth + 1)];
          break;
        default:
          throw this.error(
            "ONENOTE_PROPERTY_TYPE",
            `The property set contains an unsupported representation type 0x${type.toString(16).padStart(2, "0")}.`
          );
      }
      properties.push(property);
    }
    return { properties, encodedLength: this.position - start };
  }
  setScalar(property, byteCount) {
    const bytes = this.readBytes(byteCount);
    let value = 0;
    let exact = true;
    for (let index = bytes.length - 1; index >= 0; index--) {
      if (value > Number.MAX_SAFE_INTEGER / 256) exact = false;
      value = value * 256 + bytes[index];
    }
    if (exact) property.scalarValue = value;
    property.data = bytes;
  }
  readReferenceCount() {
    const count = this.readUInt32();
    if (count > this.options.maxObjects) {
      throw this.error("ONENOTE_REFERENCE_COUNT", "A property reference count exceeds the configured object limit.");
    }
    return count;
  }
  readCompactId() {
    const compact = this.readUInt32();
    const value = compact & 255;
    const index = compact >>> 8;
    const identifier = this.globalIds.get(index);
    if (identifier === void 0) {
      throw this.error("ONENOTE_COMPACT_ID", "A property reference uses a missing global-identification table entry.");
    }
    return { identifier, value, encodedLength: 4 };
  }
  readUInt16() {
    this.ensure(2);
    const value = readUInt162(this.data, this.position);
    this.position += 2;
    return value;
  }
  readUInt32() {
    this.ensure(4);
    const value = readUInt322(this.data, this.position);
    this.position += 4;
    return value;
  }
  readBytes(length) {
    this.ensure(length);
    const value = this.data.subarray(this.position, this.position + length);
    this.position += length;
    return value;
  }
  ensure(length) {
    if (length < 0 || this.position > this.data.length - length) {
      throw this.error("ONENOTE_TRUNCATED_PROPERTY_SET", "The object data ended inside a property set.");
    }
  }
};
var ReferenceCounters = class {
  constructor(oids, osids, contexts) {
    this.oids = oids;
    this.osids = osids;
    this.contexts = contexts;
  }
  oidIndex = 0;
  osidIndex = 0;
  contextIndex = 0;
  takeOids(count, cursor) {
    const taken = this.take(this.oids, this.oidIndex, count, cursor, "object");
    this.oidIndex += count;
    return taken;
  }
  takeOsids(count, cursor) {
    const taken = this.take(this.osids, this.osidIndex, count, cursor, "object-space");
    this.osidIndex += count;
    return taken;
  }
  takeContexts(count, cursor) {
    const taken = this.take(this.contexts, this.contextIndex, count, cursor, "context");
    this.contextIndex += count;
    return taken;
  }
  take(source, index, count, cursor, kind) {
    if (count < 0 || index > source.length - count) {
      throw cursor.error("ONENOTE_REFERENCE_STREAM", `A property consumes more ${kind} identifiers than its object stream contains.`);
    }
    return source.slice(index, index + count);
  }
};
function readPropertySet(data, globalIds, options, absoluteOffset) {
  const cursor = new Cursor(data, globalIds, options, absoluteOffset);
  const oids = cursor.readReferenceStream();
  let osids = EMPTY_STREAM;
  let contexts = EMPTY_STREAM;
  if (!oids.osidStreamNotPresent) {
    osids = cursor.readReferenceStream();
    if (osids.extendedStreamsPresent) contexts = cursor.readReferenceStream();
  }
  return cursor.readPropertySet(new ReferenceCounters(oids.ids, osids.ids, contexts.ids), 0);
}

// src/onenote-file/onestore/objects.ts
var FILE_DATA_HEADER = "bde316e7-2665-4511-a4c4-8d4d0b7a9eac";
var FILE_DATA_FOOTER = "71fba722-0f79-4a0b-bb13-899256426b24";
function keyOf(id) {
  return `${id.identifier}:${id.value}`;
}
function isEmptyGuid(id) {
  return id.identifier === EMPTY_GUID && id.value === 0;
}
function readExtendedGuidAt(data, offset) {
  return { identifier: readGuid(data, offset), value: readUInt322(data, offset + 16), encodedLength: 20 };
}
function resolveCompactId(data, offset, globalIds, absoluteOffset) {
  const compact = readUInt322(data, offset);
  const identifier = globalIds.get(compact >>> 8);
  if (identifier === void 0) {
    throw new OneNoteFormatError("ONENOTE_COMPACT_ID", "A CompactID references a missing global-identification table entry.", absoluteOffset);
  }
  return { identifier, value: compact & 255, encodedLength: 4 };
}
function readByte(data, offset) {
  if (offset < 0 || offset >= data.length) {
    throw new OneNoteFormatError("ONENOTE_TRUNCATED_STRUCTURE", "The OneNote file ended before a required structure could be read.", offset);
  }
  return data[offset];
}
function readStorageString(data, position, absoluteOffset) {
  const characterCount = readUInt322(data, position);
  position += 4;
  if (characterCount > 1073741823 || position > data.length - characterCount * 2) {
    throw new OneNoteFormatError("ONENOTE_STORAGE_STRING", "A StringInStorageBuffer length exceeds its containing structure.", absoluteOffset + position - 4);
  }
  const bytes = data.subarray(position, position + characterCount * 2);
  return { value: new TextDecoder("utf-16le").decode(bytes), next: position + characterCount * 2 };
}
var GraphReader = class {
  constructor(file, declaredFileLength, options) {
    this.file = file;
    this.declaredFileLength = declaredFileLength;
    this.options = options;
  }
  result = { revisions: [], objects: [], fileDataObjects: [] };
  visited = /* @__PURE__ */ new Set();
  knownRevisions = /* @__PURE__ */ new Map();
  knownJcids = /* @__PURE__ */ new Map();
  nextRoleAssociationOrder = 0;
  totalAssetBytes = 0;
  processList(list) {
    if (this.visited.has(list)) return;
    this.visited.add(list);
    const frames = [{ list, globalIds: /* @__PURE__ */ new Map(), nextNodeIndex: 0 }];
    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      if (frame.nextNodeIndex >= frame.list.nodes.length) {
        frames.pop();
        continue;
      }
      const node = frame.list.nodes[frame.nextNodeIndex++];
      this.processNode(node, frame);
      if (node.referencedList && !this.visited.has(node.referencedList)) {
        this.visited.add(node.referencedList);
        const inherited = node.id === FileNodeId.objectGroupListReference ? frame.currentRevision : void 0;
        frames.push({
          list: node.referencedList,
          globalIds: /* @__PURE__ */ new Map(),
          currentRevision: inherited,
          currentObjectSpace: inherited?.objectSpaceId,
          nextNodeIndex: 0
        });
      }
    }
  }
  processNode(node, frame) {
    switch (node.id) {
      case FileNodeId.revisionManifestListStart:
        frame.currentObjectSpace = readExtendedGuidAt(node.data, 0);
        break;
      case FileNodeId.revisionManifestStart4:
      case FileNodeId.revisionManifestStart6:
      case FileNodeId.revisionManifestStart7: {
        const revision = this.readRevisionManifest(node);
        revision.objectSpaceId = frame.currentObjectSpace;
        revision.roleAssociations.push({ contextId: revision.contextId, role: revision.role, order: this.nextRoleAssociationOrder++ });
        if (this.knownRevisions.has(keyOf(revision.id))) {
          throw new OneNoteFormatError("ONENOTE_REVISION_ID", "A revision manifest identifier is duplicated.", node.fileOffset);
        }
        this.knownRevisions.set(keyOf(revision.id), revision);
        this.result.revisions.push(revision);
        frame.currentRevision = revision;
        break;
      }
      case FileNodeId.revisionRoleDeclaration:
        this.readRevisionRoleDeclaration(node, frame.currentObjectSpace, false);
        break;
      case FileNodeId.revisionRoleAndContextDeclaration:
        this.readRevisionRoleDeclaration(node, frame.currentObjectSpace, true);
        break;
      case FileNodeId.globalIdTableStart:
      case FileNodeId.globalIdTableStart2:
        frame.globalIds.clear();
        break;
      case FileNodeId.globalIdTableEntry:
        readGlobalIdEntry(node, frame.globalIds);
        break;
      case FileNodeId.rootObjectReference2:
      case FileNodeId.rootObjectReference3:
        if (frame.currentRevision) readRootReference(node, frame.globalIds, frame.currentRevision);
        break;
      case FileNodeId.objectDeclarationWithRefCount:
      case FileNodeId.objectDeclarationWithRefCount2:
      case FileNodeId.objectDeclaration2RefCount:
      case FileNodeId.objectDeclaration2LargeRefCount:
      case FileNodeId.readOnlyObjectDeclaration2RefCount:
      case FileNodeId.readOnlyObjectDeclaration2LargeRefCount:
      case FileNodeId.objectRevisionWithRefCount:
      case FileNodeId.objectRevisionWithRefCount2:
        this.readObject(node, frame.globalIds, frame.currentRevision);
        break;
      case FileNodeId.objectDeclarationFileData3RefCount:
      case FileNodeId.objectDeclarationFileData3LargeRefCount:
        this.readFileDataDeclaration(node, frame.globalIds, frame.currentRevision);
        break;
      case FileNodeId.fileDataStoreObjectReference:
        this.readFileDataStoreObject(node);
        break;
    }
  }
  readRevisionManifest(node) {
    const id = readExtendedGuidAt(node.data, 0);
    const dependency = readExtendedGuidAt(node.data, 20);
    const roleOffset = node.id === FileNodeId.revisionManifestStart4 ? 48 : 40;
    const manifest = {
      id,
      dependencyId: isEmptyGuid(dependency) ? void 0 : dependency,
      role: readUInt322(node.data, roleOffset),
      isEncrypted: readUInt162(node.data, roleOffset + 4) !== 0,
      rootObjects: [],
      roleAssociations: []
    };
    if (node.id === FileNodeId.revisionManifestStart7) manifest.contextId = readExtendedGuidAt(node.data, 46);
    return manifest;
  }
  readRevisionRoleDeclaration(node, currentObjectSpace, includesContext) {
    const revisionId = readExtendedGuidAt(node.data, 0);
    const role = readUInt322(node.data, 20);
    if (role > 65535) {
      throw new OneNoteFormatError("ONENOTE_REVISION_ROLE", "A revision-role label has nonzero reserved high bytes.", node.fileOffset + 20);
    }
    const revision = this.knownRevisions.get(keyOf(revisionId));
    if (!revision || !currentObjectSpace || !revision.objectSpaceId || keyOf(currentObjectSpace) !== keyOf(revision.objectSpaceId)) {
      throw new OneNoteFormatError(
        "ONENOTE_REVISION_ROLE_TARGET",
        "A revision-role declaration does not reference a preceding revision in the current object space.",
        node.fileOffset
      );
    }
    let contextId;
    if (includesContext) {
      const context = readExtendedGuidAt(node.data, 24);
      if (!isEmptyGuid(context)) contextId = context;
    }
    revision.roleAssociations.push({ contextId, role, order: this.nextRoleAssociationOrder++ });
  }
  readObject(node, globalIds, revision) {
    if (this.result.objects.length >= this.options.maxObjects) {
      throw new OneNoteFormatError("ONENOTE_OBJECT_LIMIT", "The object declaration limit was exceeded.", node.fileOffset);
    }
    if (!node.chunkReference || node.chunkReference.isNil || node.chunkReference.offset === 0 && node.chunkReference.length === 0) {
      throw new OneNoteFormatError("ONENOTE_OBJECT_REFERENCE", "An object declaration does not reference object data.", node.fileOffset);
    }
    const bodyOffset = node.chunkReference.encodedLength;
    const id = resolveCompactId(node.data, bodyOffset, globalIds, node.fileOffset + bodyOffset);
    const isRevision = node.id === FileNodeId.objectRevisionWithRefCount || node.id === FileNodeId.objectRevisionWithRefCount2;
    let jcid;
    let referenceCount;
    if (node.id === FileNodeId.objectDeclarationWithRefCount || node.id === FileNodeId.objectDeclarationWithRefCount2) {
      jcid = 131073;
      const countOffset = bodyOffset + 10;
      referenceCount = node.id === FileNodeId.objectDeclarationWithRefCount ? readByte(node.data, countOffset) : readUInt322(node.data, countOffset);
    } else if (isRevision) {
      jcid = this.knownJcids.get(keyOf(id)) ?? 0;
      const flagsOffset = bodyOffset + 4;
      referenceCount = node.id === FileNodeId.objectRevisionWithRefCount ? readByte(node.data, flagsOffset) >> 2 : readUInt322(node.data, flagsOffset + 4);
    } else {
      jcid = readUInt322(node.data, bodyOffset + 4);
      const countOffset = bodyOffset + 9;
      const large = node.id === FileNodeId.objectDeclaration2LargeRefCount || node.id === FileNodeId.readOnlyObjectDeclaration2LargeRefCount;
      referenceCount = large ? readUInt322(node.data, countOffset) : readByte(node.data, countOffset);
    }
    const record = { id, jcid, referenceCount, revisionId: revision?.id, isRevision };
    if (!revision?.isEncrypted) {
      const objectData = this.referencedRange(node.chunkReference, 0, node.chunkReference.length, "object property set");
      record.propertySet = readPropertySet(objectData, globalIds, this.options, node.chunkReference.offset);
    }
    this.result.objects.push(record);
    if (jcid !== 0) this.knownJcids.set(keyOf(id), jcid);
  }
  readFileDataDeclaration(node, globalIds, revision) {
    if (this.result.objects.length >= this.options.maxObjects) {
      throw new OneNoteFormatError("ONENOTE_OBJECT_LIMIT", "The object declaration limit was exceeded.", node.fileOffset);
    }
    const id = resolveCompactId(node.data, 0, globalIds, node.fileOffset);
    const jcid = readUInt322(node.data, 4);
    const large = node.id === FileNodeId.objectDeclarationFileData3LargeRefCount;
    const referenceCount = large ? readUInt322(node.data, 8) : readByte(node.data, 8);
    const reference = readStorageString(node.data, large ? 12 : 9, node.fileOffset);
    const extension = readStorageString(node.data, reference.next, node.fileOffset);
    this.result.objects.push({
      id,
      jcid,
      referenceCount,
      revisionId: revision?.id,
      isRevision: false,
      fileDataReference: reference.value,
      fileExtension: extension.value
    });
    this.knownJcids.set(keyOf(id), jcid);
  }
  readFileDataStoreObject(node) {
    if (!node.chunkReference || node.chunkReference.isNil || node.chunkReference.offset === 0 && node.chunkReference.length === 0) return;
    const referenceId = readGuid(node.data, node.chunkReference.encodedLength);
    if (node.chunkReference.length < 52) {
      throw new OneNoteFormatError("ONENOTE_FILE_DATA_LENGTH", "A FileDataStoreObject is shorter than its required framing.", node.chunkReference.offset);
    }
    const header = this.referencedRange(node.chunkReference, 0, 36, "file-data store object header");
    const length = readUInt64(header, 16);
    if (length > node.chunkReference.length - 52) {
      throw new OneNoteFormatError("ONENOTE_FILE_DATA_LENGTH", "A FileDataStoreObject payload length exceeds its containing frame.", node.chunkReference.offset + 16);
    }
    if (length > this.options.maxAssetBytes || this.totalAssetBytes > this.options.maxTotalAssetBytes - length) {
      throw new OneNoteFormatError("ONENOTE_ASSET_LIMIT", "An embedded OneNote asset exceeds the configured materialization limits.", node.fileOffset);
    }
    const footer = this.referencedRange(node.chunkReference, node.chunkReference.length - 16, 16, "file-data store object footer");
    if (readGuid(header, 0) !== FILE_DATA_HEADER || readGuid(footer, 0) !== FILE_DATA_FOOTER) {
      throw new OneNoteFormatError("ONENOTE_FILE_DATA_FRAMING", "A FileDataStoreObject has invalid framing GUIDs.", node.chunkReference.offset);
    }
    const payload = this.referencedRange(node.chunkReference, 36, length, "file-data store object payload");
    this.totalAssetBytes += payload.length;
    this.result.fileDataObjects.push({ referenceId, payload });
  }
  referencedRange(reference, relativeOffset, length, name) {
    if (reference.offset > this.declaredFileLength || reference.length > this.declaredFileLength - reference.offset) {
      throw new OneNoteFormatError("ONENOTE_CHUNK_REFERENCE_BOUNDS", `The ${name} lies outside the declared file length.`, reference.offset);
    }
    if (length < 0 || relativeOffset > reference.length || length > reference.length - relativeOffset) {
      throw new OneNoteFormatError("ONENOTE_CHUNK_REFERENCE_BOUNDS", `The ${name} lies outside its containing chunk reference.`, reference.offset);
    }
    const absoluteOffset = reference.offset + relativeOffset;
    if (absoluteOffset + length > this.file.length) {
      throw new OneNoteFormatError("ONENOTE_TRUNCATED_STRUCTURE", `The file ended while reading ${name}.`, absoluteOffset);
    }
    return this.file.subarray(absoluteOffset, absoluteOffset + length);
  }
};
function readGlobalIdEntry(node, globalIds) {
  const index = readUInt322(node.data, 0);
  if (index >= 16777215 || globalIds.has(index)) {
    throw new OneNoteFormatError("ONENOTE_GLOBAL_ID_INDEX", "A global-identification table index is invalid or duplicated.", node.fileOffset);
  }
  const identifier = readGuid(node.data, 4);
  if (identifier === EMPTY_GUID) {
    throw new OneNoteFormatError("ONENOTE_GLOBAL_ID_GUID", "A global-identification table contains an empty GUID.", node.fileOffset + 4);
  }
  globalIds.set(index, identifier);
}
function readRootReference(node, globalIds, revision) {
  const isExtended = node.id === FileNodeId.rootObjectReference3;
  const objectId = isExtended ? readExtendedGuidAt(node.data, 0) : resolveCompactId(node.data, 0, globalIds, node.fileOffset);
  revision.rootObjects.push({ objectId, role: readUInt322(node.data, isExtended ? 20 : 4) });
}
function readObjectGraph(file, root, declaredFileLength, options) {
  const reader = new GraphReader(file, declaredFileLength, options);
  reader.processList(root);
  return reader.result;
}

// src/onenote-file/onestore/transaction-log.ts
var TRANSACTION_ENTRY_LENGTH = 8;
var NEXT_FRAGMENT_LENGTH = 12;
var ONE_POLYNOMIAL = 3988292384;
var MSO_POLYNOMIAL = 175;
function continueCrc(crc, data, offset, count, fileKind) {
  const end = offset + count;
  if (fileKind === "section") {
    let state2 = ~crc >>> 0;
    for (let index = offset; index < end; index++) {
      state2 = (state2 ^ data[index]) >>> 0;
      for (let bit = 0; bit < 8; bit++) state2 = (state2 >>> 1 ^ ((state2 & 1) !== 0 ? ONE_POLYNOMIAL : 0)) >>> 0;
    }
    return ~state2 >>> 0;
  }
  let state = crc >>> 0;
  for (let index = offset; index < end; index++) {
    state = (state ^ data[index] << 24) >>> 0;
    for (let bit = 0; bit < 8; bit++) state = (state << 1 >>> 0 ^ ((state & 2147483648) !== 0 ? MSO_POLYNOMIAL : 0)) >>> 0;
  }
  return state;
}
function readTransactionLog(file, header, options) {
  if (!header.transactionLog || header.transactionCount === void 0 || header.expectedFileLength === void 0) {
    throw new OneNoteFormatError("ONENOTE_TRANSACTION_LOG_HEADER", "The revision-store header does not expose a complete transaction log reference.");
  }
  let current = header.transactionLog;
  let completedTransactions = 0;
  let fragmentCount = 0;
  let entryCount = 0;
  let runningCrc = 0;
  const visitedOffsets = /* @__PURE__ */ new Set();
  const nodeCounts = /* @__PURE__ */ new Map();
  while (completedTransactions < header.transactionCount) {
    if (current.isNil || current.offset === 0 && current.length === 0 || current.length < TRANSACTION_ENTRY_LENGTH + NEXT_FRAGMENT_LENGTH) {
      throw new OneNoteFormatError("ONENOTE_TRANSACTION_LOG_TRUNCATED", "The transaction log ended before all committed transactions were found.", current.offset);
    }
    if (++fragmentCount > options.maxTransactionLogFragments) {
      throw new OneNoteFormatError("ONENOTE_TRANSACTION_FRAGMENT_LIMIT", "The transaction-log fragment limit was exceeded.", current.offset);
    }
    if (visitedOffsets.has(current.offset)) {
      throw new OneNoteFormatError("ONENOTE_TRANSACTION_FRAGMENT_CYCLE", "The transaction-log fragment chain contains a cycle.", current.offset);
    }
    visitedOffsets.add(current.offset);
    if (current.offset > header.expectedFileLength || current.length > header.expectedFileLength - current.offset) {
      throw new OneNoteFormatError("ONENOTE_TRANSACTION_FRAGMENT_BOUNDS", "A transaction-log fragment lies outside the declared file length.", current.offset);
    }
    if (current.offset + current.length > file.length) {
      throw new OneNoteFormatError("ONENOTE_TRANSACTION_FRAGMENT_TRUNCATED", "The file ended while reading a transaction-log fragment.", current.offset);
    }
    const data = file.subarray(current.offset, current.offset + current.length);
    const entryBytes = Math.floor((data.length - NEXT_FRAGMENT_LENGTH) / TRANSACTION_ENTRY_LENGTH) * TRANSACTION_ENTRY_LENGTH;
    let offset = 0;
    while (offset < entryBytes && completedTransactions < header.transactionCount) {
      if (++entryCount > options.maxTransactionEntries) {
        throw new OneNoteFormatError("ONENOTE_TRANSACTION_ENTRY_LIMIT", "The transaction-entry limit was exceeded.", current.offset + offset);
      }
      const sourceId = readUInt322(data, offset);
      const value = readUInt322(data, offset + 4);
      if (sourceId === 1) {
        if (options.validateTransactionChecksums && value !== runningCrc) {
          throw new OneNoteFormatError("ONENOTE_TRANSACTION_CHECKSUM", "A committed transaction has an invalid sentinel checksum.", current.offset + offset + 4);
        }
        completedTransactions++;
        runningCrc = continueCrc(runningCrc, data, offset, TRANSACTION_ENTRY_LENGTH, header.fileKind);
        offset += TRANSACTION_ENTRY_LENGTH;
        continue;
      }
      if (sourceId < 16) {
        throw new OneNoteFormatError("ONENOTE_TRANSACTION_SOURCE_ID", "A transaction entry contains an invalid file-node-list identity.", current.offset + offset);
      }
      if (value > options.maxFileNodes) {
        throw new OneNoteFormatError("ONENOTE_TRANSACTION_FILE_NODE_COUNT", "A transaction entry contains an invalid file-node count.", current.offset + offset + 4);
      }
      const previousCount = nodeCounts.get(sourceId);
      if (previousCount !== void 0 && value <= previousCount) {
        throw new OneNoteFormatError("ONENOTE_TRANSACTION_FILE_NODE_SEQUENCE", "A transaction entry does not increase its file-node-list count.", current.offset + offset + 4);
      }
      nodeCounts.set(sourceId, value);
      runningCrc = continueCrc(runningCrc, data, offset, TRANSACTION_ENTRY_LENGTH, header.fileKind);
      offset += TRANSACTION_ENTRY_LENGTH;
    }
    if (completedTransactions >= header.transactionCount) break;
    current = readFileChunkReference64x32(data, entryBytes);
  }
  if (nodeCounts.size === 0) {
    throw new OneNoteFormatError("ONENOTE_TRANSACTION_LOG_EMPTY", "The committed transaction log declares no file-node lists.");
  }
  return nodeCounts;
}

// src/onenote-file/onestore/revision-store.ts
function readRevisionStore(file, options = DEFAULT_READER_OPTIONS) {
  const header = readFileHeader(file, file.length, options);
  if (header.storageFormat !== "revision-store") {
    throw new OneNoteFormatError("ONENOTE_NOT_REVISION_STORE", "The OneNote artifact does not use the desktop MS-ONESTORE encoding.");
  }
  if (header.expectedFileLength === void 0 || !header.rootFileNodeList) {
    throw new OneNoteFormatError("ONENOTE_REVISION_STORE_HEADER", "The revision-store header does not expose its required root structures.");
  }
  const committedNodeCounts = readTransactionLog(file, header, options);
  const root = readFileNodeList(file, header.rootFileNodeList, header.expectedFileLength, committedNodeCounts, options);
  validateRootList(root, header.fileKind);
  const lists = linkReachableLists(file, root, header.rootFileNodeList.offset, header.expectedFileLength, committedNodeCounts, options);
  const graph = readObjectGraph(file, root, header.expectedFileLength, options);
  return { header, root, lists, graph };
}
function linkReachableLists(file, root, rootOffset, declaredFileLength, committedNodeCounts, options) {
  const lists = [root];
  const byOffset = /* @__PURE__ */ new Map([[rootOffset, root]]);
  const queue = [root];
  let totalNodes = root.nodes.length;
  while (queue.length > 0) {
    const parent = queue.shift();
    for (const node of parent.nodes) {
      if (node.baseType !== "file-node-list-reference" || !node.chunkReference || node.chunkReference.isNil || node.chunkReference.offset === 0 && node.chunkReference.length === 0) {
        continue;
      }
      const childOffset = node.chunkReference.offset;
      const existing = byOffset.get(childOffset);
      if (existing) {
        node.referencedList = existing;
        continue;
      }
      const firstFragment = { offset: childOffset, length: node.chunkReference.length, isNil: false };
      const child = readFileNodeList(file, firstFragment, declaredFileLength, committedNodeCounts, options);
      if (totalNodes > options.maxFileNodes - child.nodes.length) {
        throw new OneNoteFormatError("ONENOTE_FILE_NODE_LIMIT", "The file-node limit was exceeded while traversing referenced lists.", node.fileOffset);
      }
      totalNodes += child.nodes.length;
      node.referencedList = child;
      byOffset.set(childOffset, child);
      lists.push(child);
      queue.push(child);
    }
  }
  return lists;
}
function validateRootList(root, fileKind) {
  let manifestReferences = 0;
  let rootDeclarations = 0;
  for (const node of root.nodes) {
    if (node.id === FileNodeId.objectSpaceManifestListReference) manifestReferences++;
    if (node.id === FileNodeId.objectSpaceManifestRoot) rootDeclarations++;
  }
  if (manifestReferences < 1 || rootDeclarations !== 1) {
    throw new OneNoteFormatError(
      "ONENOTE_ROOT_FILE_NODE_LIST",
      "The root file-node list does not contain the required object-space references and single root declaration."
    );
  }
  for (const node of root.nodes) {
    const allowed = node.id === FileNodeId.objectSpaceManifestListReference || node.id === FileNodeId.objectSpaceManifestRoot || node.id === FileNodeId.chunkTerminator || fileKind === "section" && node.id === FileNodeId.fileDataStoreListReference;
    if (!allowed) {
      throw new OneNoteFormatError("ONENOTE_ROOT_FILE_NODE_TYPE", "The root file-node list contains a file-node type that is not valid at the root.", node.fileOffset);
    }
  }
}

// src/onenote-file/semantic/ink.ts
var NATIVE_UNITS_PER_HALF_INCH = 1270;
var X_DIMENSION = "598a6a8f-52c0-4ba0-93af-af357411a561";
var Y_DIMENSION = "b53f9f75-04e0-4498-a7ee-c30dbb5a9011";
var PRESSURE_DIMENSION = "2d500773-f4f9-4e18-b3f2-2ce1b1a3610c";
function decodeDimensions(data) {
  if (!data || data.length === 0) return [];
  const dimensions = [];
  for (let offset = 0; offset + 32 <= data.length; offset += 32) {
    dimensions.push({
      id: readGuid(data, offset),
      lower: readUInt322(data, offset + 16) | 0,
      upper: readUInt322(data, offset + 20) | 0
    });
  }
  return dimensions;
}
function readVarUInt(data, cursor) {
  let value = 0;
  let shift = 1;
  for (let index = 0; index < 10; index++) {
    if (cursor.offset >= data.length) {
      throw new OneNoteFormatError("ONENOTE_INK_VARINT", "The ink path contains a truncated multi-byte integer.");
    }
    const current = data[cursor.offset++];
    value += (current & 127) * shift;
    if ((current & 128) === 0) return value;
    shift *= 128;
    if (shift > Number.MAX_SAFE_INTEGER) {
      throw new OneNoteFormatError("ONENOTE_INK_VARINT", "The ink path contains a multi-byte integer wider than supported.");
    }
  }
  throw new OneNoteFormatError("ONENOTE_INK_VARINT", "The ink path contains an invalid multi-byte integer.");
}
function decodeSignedVector(data, maximumValues) {
  if (!data || data.length === 0) return [];
  const cursor = { offset: 0 };
  const count = Math.floor(readVarUInt(data, cursor) / 2);
  if (count > maximumValues) {
    throw new OneNoteFormatError("ONENOTE_INK_PATH_LIMIT", "The ink path exceeds the configured property value limit.");
  }
  const values = new Array(count);
  for (let index = 0; index < count; index++) {
    if (cursor.offset >= data.length) {
      throw new OneNoteFormatError("ONENOTE_INK_PATH_TRUNCATED", "The ink path ends before all declared coordinates were decoded.");
    }
    const encoded = readVarUInt(data, cursor);
    const magnitude = Math.floor(encoded / 2);
    values[index] = (encoded & 1) === 0 ? magnitude : -magnitude;
  }
  return values;
}
function decodePacketValues(encoded, start, count) {
  const values = new Array(count);
  if (count === 0) return values;
  let value = encoded[start];
  values[0] = value;
  for (let packet = 1; packet < count; packet++) {
    value += encoded[start + packet];
    values[packet] = value;
  }
  return values;
}
function indexOfDimension(dimensions, id) {
  return dimensions.findIndex((dimension) => dimension.id === id);
}
var InkDimensionId = {
  x: X_DIMENSION,
  y: Y_DIMENSION,
  pressure: PRESSURE_DIMENSION
};
function decodeInkColor(color) {
  if (color === void 0) return "#000000";
  const red = color & 255;
  const green = color >> 8 & 255;
  const blue = color >> 16 & 255;
  const hex = (value) => value.toString(16).padStart(2, "0");
  return `#${hex(red)}${hex(green)}${hex(blue)}`;
}
function decodeRecognitionAlternatives(data) {
  if (!data || data.length < 2) return [];
  const text = new TextDecoder("utf-16le").decode(data.subarray(0, data.length - data.length % 2));
  return text.split("\0").filter((part) => part !== "");
}

// src/onenote-file/semantic/schema.ts
var Jcid = {
  sectionNode: 393223,
  pageSeriesNode: 393224,
  pageNode: 393227,
  outlineNode: 393228,
  outlineElementNode: 393229,
  richTextNode: 393230,
  imageNode: 393233,
  numberListNode: 393234,
  outlineGroup: 393241,
  tableNode: 393250,
  tableRowNode: 393251,
  tableCellNode: 393252,
  titleNode: 393260,
  pageMetadata: 131120,
  sectionMetadata: 131121,
  embeddedFileNode: 393269,
  pageManifestNode: 393271,
  conflictPageMetadata: 131128,
  author: 1179649,
  inkContainer: 393236,
  inkDataNode: 131131,
  inkStrokeNode: 131143,
  strokePropertiesNode: 1179720,
  recognizedTextWord: 131159,
  noteTagSharedDefinition: 1179715
};
var Property = {
  contentChildNodes: 603986975,
  elementChildNodes: 603986976,
  structureElementChildNodes: 603987295,
  listNodes: 603986982,
  richEditTextUnicode: 469769250,
  textExtendedAscii: 469775512,
  childGraphSpaceElementNodes: 738205027,
  cachedTitleString: 469769459,
  cachedTitleStringFromPage: 469769532,
  author: 469769589,
  sectionDisplayName: 469775515,
  notebookColor: 335551678,
  pageLevel: 335551999,
  topologyCreationTimestamp: 402660453,
  lastModifiedTimestamp: 402660727,
  lastModifiedTime: 335551866,
  isConflictPage: 134225276,
  isDeletedGraphSpaceContent: 469769705,
  textRunIndex: 469769746,
  textRunFormatting: 603987475,
  hyperlink: 134225428,
  hyperlinkUrl: 469769760,
  mathFormatting: 134231041,
  highlight: 335551501,
  actionItemType: 268448867,
  noteTagShape: 268448868,
  noteTagLabel: 469775464,
  actionItemStatus: 268448880,
  noteTagDefinitionOid: 536884360,
  noteTagStates: 1073755273,
  bold: 134224900,
  italic: 134224901,
  underline: 134224902,
  strikethrough: 134224903,
  superscript: 134224904,
  subscript: 134224905,
  font: 469769226,
  fontSize: 268442635,
  outlineElementChildLevel: 201333763,
  numberListFormat: 469769242,
  paragraphStyle: 536884268,
  paragraphStyleId: 469775450,
  tableBordersVisible: 134225246,
  tableColumnWidths: 469769574,
  pictureContainer: 536878143,
  embeddedFileContainer: 536878491,
  embeddedFileName: 469769628,
  sourceFilePath: 469769629,
  imageFilename: 469769687,
  imageAltText: 469769816,
  fileDataReference: 469775422,
  fileDataExtension: 469775396,
  inkStrokeProperties: 536884233,
  inkDimensions: 469775370,
  inkPath: 469775371,
  inkWidth: 335557645,
  inkColor: 335557647,
  inkTransparency: 201339924,
  inkData: 536884245,
  inkStrokes: 603993110,
  inkScalingX: 335551558,
  inkScalingY: 335551559,
  pageRecognizedTextContainer: 536884695,
  recognizedTextChildNodes: 603993561,
  recognizedText: 469775834,
  recognizedTextStrokeReferences: 469775839
};
var HEADER_CELL_OBJECT_SPACE_ID = "111e4cf3-7fef-4087-af6a-b9544acd334d";

// src/onenote-file/semantic/object-space.ts
function spaceKey(id, contextId) {
  return `${keyOf(id)}|${contextId ? keyOf(contextId) : "default"}`;
}
var ObjectSpaceMaterializer = class {
  revisions = /* @__PURE__ */ new Map();
  spaces = /* @__PURE__ */ new Map();
  objectsByRevision = /* @__PURE__ */ new Map();
  fileData = /* @__PURE__ */ new Map();
  cache = /* @__PURE__ */ new Map();
  constructor(store) {
    for (const revision of store.graph.revisions) {
      this.revisions.set(keyOf(revision.id), revision);
      if (revision.objectSpaceId) {
        const key = keyOf(revision.objectSpaceId);
        const existing = this.spaces.get(key);
        if (existing) existing.push(revision);
        else this.spaces.set(key, [revision]);
      }
    }
    for (const object of store.graph.objects) {
      if (!object.revisionId) continue;
      const key = keyOf(object.revisionId);
      const existing = this.objectsByRevision.get(key);
      if (existing) existing.push(object);
      else this.objectsByRevision.set(key, [object]);
    }
    for (const item of store.graph.fileDataObjects) this.fileData.set(item.referenceId, item);
  }
  findCurrentSpaceByRootJcid(jcid) {
    for (const revisions of this.spaces.values()) {
      const id = revisions[0].objectSpaceId;
      if (id.identifier === HEADER_CELL_OBJECT_SPACE_ID && id.value === 1) continue;
      const space = this.tryGetSpace(id);
      if (space?.getRoot(1)?.jcid === jcid) return space;
    }
    return void 0;
  }
  tryGetSpace(id, contextId) {
    const key = spaceKey(id, contextId);
    if (this.cache.has(key)) return this.cache.get(key);
    const revisions = this.spaces.get(keyOf(id));
    if (!revisions) {
      this.cache.set(key, void 0);
      return void 0;
    }
    let current;
    let bestOrder = -1;
    for (const revision of revisions) {
      if (revision.isEncrypted) continue;
      for (const association of revision.roleAssociations) {
        if (association.role !== 1) continue;
        if (!contextEquals(association.contextId, contextId)) continue;
        if (association.order >= bestOrder) {
          bestOrder = association.order;
          current = revision;
        }
      }
    }
    if (!current) {
      this.cache.set(key, void 0);
      return void 0;
    }
    const objects = /* @__PURE__ */ new Map();
    const roots = /* @__PURE__ */ new Map();
    for (const revision of this.getRevisionChain(current)) {
      for (const declaration of this.objectsByRevision.get(keyOf(revision.id)) ?? []) {
        objects.set(keyOf(declaration.id), declaration);
      }
      for (const root of revision.rootObjects) roots.set(root.role, root.objectId);
    }
    const space = {
      revision: current,
      getObject: (objectId) => objects.get(keyOf(objectId)),
      getRoot: (role) => {
        const rootId = roots.get(role);
        return rootId ? objects.get(keyOf(rootId)) : void 0;
      }
    };
    this.cache.set(key, space);
    return space;
  }
  getRevisionChain(revision) {
    const chain = [];
    const visited = /* @__PURE__ */ new Set();
    let current = revision;
    while (current && !visited.has(keyOf(current.id))) {
      visited.add(keyOf(current.id));
      chain.push(current);
      current = current.dependencyId ? this.revisions.get(keyOf(current.dependencyId)) : void 0;
    }
    return chain.reverse();
  }
  resolveFileData(item) {
    const reference = item.fileDataReference;
    if (!reference || !reference.toLowerCase().startsWith("<ifndf>")) return void 0;
    const value = reference.slice(7).trim().replace(/\0+$/, "").replace(/^\{|\}$/g, "").toLowerCase();
    return this.fileData.get(value)?.payload;
  }
};
function contextEquals(left, right) {
  if (!left) return !right;
  if (!right) return false;
  return keyOf(left) === keyOf(right);
}

// src/onenote-file/semantic/properties.ts
function findProperty(set, propertyId) {
  if (!set) return void 0;
  const normalized = propertyId & 2147483647;
  for (let index = set.properties.length - 1; index >= 0; index--) {
    if ((set.properties[index].rawId & 2147483647) === normalized) return set.properties[index];
  }
  return void 0;
}
function readData(item, propertyId) {
  return findProperty(item?.propertySet, propertyId)?.data;
}
function readReferences(item, propertyId) {
  return findProperty(item?.propertySet, propertyId)?.referencedIds ?? [];
}
function readString(item, propertyId) {
  const data = readData(item, propertyId);
  if (!data || data.length === 0) return void 0;
  const even = data.length - data.length % 2;
  return trimTrailingNulls(new TextDecoder("utf-16le").decode(data.subarray(0, even)));
}
function readSingleByteString(item, propertyId) {
  const data = readData(item, propertyId);
  if (!data || data.length === 0) return void 0;
  let value = "";
  for (const byte of data) value += String.fromCharCode(byte);
  return trimTrailingNulls(value);
}
function readBoolean(item, propertyId) {
  return findProperty(item?.propertySet, propertyId)?.booleanValue;
}
function readUInt32Property(item, propertyId) {
  const value = findProperty(item?.propertySet, propertyId)?.scalarValue;
  return value === void 0 ? void 0 : value >>> 0;
}
function readFloat(item, propertyId) {
  const data = readData(item, propertyId);
  if (!data || data.length !== 4) return void 0;
  return new DataView(data.buffer, data.byteOffset, 4).getFloat32(0, true);
}
function readUInt32Array(item, propertyId) {
  const data = readData(item, propertyId);
  if (!data || data.length % 4 !== 0) return [];
  const values = [];
  for (let index = 0; index < data.length; index += 4) values.push(readUInt322(data, index));
  return values;
}
function readFileTime(item, propertyId) {
  const value = findProperty(item?.propertySet, propertyId)?.scalarValue;
  if (value === void 0 || value === 0) return void 0;
  const milliseconds = value / 1e4 - 116444736e5;
  return Number.isFinite(milliseconds) ? new Date(milliseconds) : void 0;
}
function readTime32(item, propertyId) {
  const value = readUInt32Property(item, propertyId);
  return value === void 0 ? void 0 : new Date(Date.UTC(1980, 0, 1) + value * 1e3);
}
function trimTrailingNulls(value) {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 0) end--;
  return value.slice(0, end);
}

// src/onenote-file/semantic/map.ts
function mapSection(store, options = DEFAULT_READER_OPTIONS) {
  const materializer = new ObjectSpaceMaterializer(store);
  const sectionSpace = materializer.findCurrentSpaceByRootJcid(Jcid.sectionNode);
  if (!sectionSpace) {
    throw new OneNoteFormatError("ONENOTE_SECTION_OBJECT_SPACE", "No current section object space could be materialized.");
  }
  const section = { name: "", pages: [] };
  const metadata = sectionSpace.getRoot(2);
  if (metadata?.jcid === Jcid.sectionMetadata) {
    section.name = readString(metadata, Property.sectionDisplayName) ?? "";
    section.colorArgb = readUInt32Property(metadata, Property.notebookColor);
  }
  const sectionRoot = sectionSpace.getRoot(1);
  if (!sectionRoot || sectionRoot.jcid !== Jcid.sectionNode) {
    throw new OneNoteFormatError("ONENOTE_SECTION_ROOT", "The current root object space does not resolve to a section node.");
  }
  const visitedPages = /* @__PURE__ */ new Set();
  for (const pageSeriesId of readReferences(sectionRoot, Property.elementChildNodes)) {
    const pageSeries = sectionSpace.getObject(pageSeriesId);
    if (pageSeries?.jcid !== Jcid.pageSeriesNode) continue;
    for (const objectSpaceId of readReferences(pageSeries, Property.childGraphSpaceElementNodes)) {
      const page = mapPage(materializer, objectSpaceId, options, visitedPages);
      if (page) section.pages.push(page);
    }
  }
  return section;
}
function mapPage(materializer, objectSpaceId, options, visitedPages) {
  const key = spaceKey(objectSpaceId);
  if (visitedPages.has(key) || visitedPages.size >= options.maxPageGraphNodes) return void 0;
  visitedPages.add(key);
  const space = materializer.tryGetSpace(objectSpaceId);
  if (!space) return void 0;
  const manifest = space.getRoot(1);
  if (manifest?.jcid !== Jcid.pageManifestNode) return void 0;
  const metadata = space.getRoot(2);
  const revisionMetadata = space.getRoot(4);
  let pageNode;
  for (const childId of readReferences(manifest, Property.contentChildNodes)) {
    const candidate = space.getObject(childId);
    if (candidate?.jcid === Jcid.pageNode) {
      pageNode = candidate;
      break;
    }
  }
  if (!pageNode) return void 0;
  const page = {
    id: keyOf(objectSpaceId),
    title: readString(metadata, Property.cachedTitleString) ?? readString(pageNode, Property.cachedTitleStringFromPage) ?? "",
    level: Math.max(0, (readUInt32Property(metadata, Property.pageLevel) ?? 1) - 1),
    createdUtc: readFileTime(metadata, Property.topologyCreationTimestamp),
    lastModifiedUtc: readFileTime(revisionMetadata, Property.lastModifiedTimestamp) ?? readTime32(pageNode, Property.lastModifiedTime),
    isConflictPage: readBoolean(metadata, Property.isConflictPage) ?? metadata?.jcid === Jcid.conflictPageMetadata,
    isDeleted: readData(metadata, Property.isDeletedGraphSpaceContent) !== void 0,
    outlines: [],
    directContent: []
  };
  const context = {
    space,
    materializer,
    options,
    recognition: collectRecognition(space, pageNode)
  };
  for (const childId of readReferences(pageNode, Property.elementChildNodes)) {
    const element = buildElement(context, childId, 0, /* @__PURE__ */ new Set());
    if (element?.kind === "outline") page.outlines.push(element);
    else if (element) page.directContent.push(element);
  }
  if (page.title.trim() === "") {
    for (const titleId of readReferences(pageNode, Property.structureElementChildNodes)) {
      const title = space.getObject(titleId);
      if (title?.jcid !== Jcid.titleNode) continue;
      const parts = [];
      for (const childId of readReferences(title, Property.elementChildNodes)) {
        const element = buildElement(context, childId, 0, /* @__PURE__ */ new Set());
        if (element) collectText(element, parts);
      }
      page.title = parts.filter((part) => part.trim() !== "").join(" ").trim();
    }
  }
  return page;
}
function buildElement(context, id, depth, path) {
  const { space, options } = context;
  const pathKey = keyOf(id);
  if (depth >= options.maxPropertySetDepth || path.has(pathKey)) return void 0;
  path.add(pathKey);
  try {
    const item = space.getObject(id);
    if (!item) return void 0;
    switch (item.jcid) {
      case Jcid.outlineNode:
      case Jcid.outlineGroup: {
        const outline = { kind: "outline", children: [] };
        for (const childId of readReferences(item, Property.elementChildNodes)) {
          const child = buildElement(context, childId, depth + 1, path);
          if (child) outline.children.push(child);
        }
        return outline;
      }
      case Jcid.outlineElementNode:
        return buildOutlineElement(context, item, depth, path);
      case Jcid.richTextNode:
        return buildParagraph(context.space, item);
      case Jcid.imageNode:
        return buildImage(context, item);
      case Jcid.embeddedFileNode:
        return buildEmbeddedFile(context, item);
      case Jcid.tableNode:
        return buildTable(context, item, depth, path);
      case Jcid.inkContainer:
        return buildInk(context, item);
      default:
        return void 0;
    }
  } finally {
    path.delete(pathKey);
  }
}
function buildOutlineElement(context, item, depth, path) {
  const { space } = context;
  let primary;
  for (const contentId of readReferences(item, Property.contentChildNodes)) {
    primary = buildElement(context, contentId, depth + 1, path);
    if (primary) break;
  }
  const list = buildListInfo(space, item);
  const children = [];
  for (const childId of readReferences(item, Property.elementChildNodes)) {
    const child = buildElement(context, childId, depth + 1, path);
    if (child) children.push(child);
  }
  const tags = buildTags(space, item);
  if (primary && primary.kind === "paragraph") {
    primary.list = list;
    primary.tags ??= tags;
    primary.children.push(...children);
    return primary;
  }
  if (primary) {
    return { kind: "outline", list, children: [primary, ...children] };
  }
  return { kind: "paragraph", runs: [], children, list };
}
function buildParagraph(space, item) {
  const text = readString(item, Property.richEditTextUnicode) ?? readSingleByteString(item, Property.textExtendedAscii) ?? "";
  const boundaries = readUInt32Array(item, Property.textRunIndex);
  const styles = readReferences(item, Property.textRunFormatting);
  const runs = [];
  let start = 0;
  const runCount = Math.max(1, boundaries.length + 1);
  for (let index = 0; index < runCount; index++) {
    let end = index < boundaries.length ? Math.min(text.length, boundaries[index]) : text.length;
    if (end < start) end = start;
    const run = { text: text.slice(start, end) };
    if (index < styles.length) applyTextStyle(run, space.getObject(styles[index]));
    runs.push(run);
    start = end;
  }
  liftHyperlinkFields(runs);
  const paragraph = { kind: "paragraph", runs, children: [], tags: buildTags(space, item) };
  for (const styleId of readReferences(item, Property.paragraphStyle)) {
    const style = space.getObject(styleId);
    if (!style) continue;
    paragraph.styleId = readString(style, Property.paragraphStyleId);
    break;
  }
  return paragraph;
}
var HYPERLINK_FIELD = /﷟\s*HYPERLINK\s+"([^"]*)"\s*/;
function liftHyperlinkFields(runs) {
  let pending;
  for (const run of runs) {
    const field = run.text.match(HYPERLINK_FIELD);
    if (field) {
      run.text = run.text.replace(HYPERLINK_FIELD, "");
      pending = field[1];
    }
    if (pending === void 0 || run.text === "") continue;
    run.hyperlinkUrl ??= pending;
    pending = void 0;
  }
}
function applyTextStyle(run, style) {
  if (!style) return;
  if (readBoolean(style, Property.mathFormatting)) run.math = true;
  const highlight = highlightColor(readUInt32Property(style, Property.highlight));
  if (highlight) run.highlight = highlight;
  if (readBoolean(style, Property.bold)) run.bold = true;
  if (readBoolean(style, Property.italic)) run.italic = true;
  if (readBoolean(style, Property.underline)) run.underline = true;
  if (readBoolean(style, Property.strikethrough)) run.strikethrough = true;
  if (readBoolean(style, Property.superscript)) run.superscript = true;
  if (readBoolean(style, Property.subscript)) run.subscript = true;
  if (readBoolean(style, Property.hyperlink)) {
    const url = readString(style, Property.hyperlinkUrl);
    if (url) run.hyperlinkUrl = url;
  }
}
function highlightColor(color) {
  if (color === void 0 || (color & 4278190080) !== 0) return void 0;
  if ((color & 16777215) === 16777215) return void 0;
  const channel = (shift) => (color >> shift & 255).toString(16).padStart(2, "0");
  return `#${channel(0)}${channel(8)}${channel(16)}`;
}
function buildTags(space, item) {
  const states = findProperty(item.propertySet, Property.noteTagStates)?.childPropertySets;
  if (!states || states.length === 0) return void 0;
  const tags = [];
  for (const state of states.slice(0, MAX_TAGS_PER_PARAGRAPH)) {
    const status = readSetUInt32(state, Property.actionItemStatus) ?? 0;
    if ((status & 16) !== 0) continue;
    const definitionId = findProperty(state, Property.noteTagDefinitionOid)?.referencedIds?.[0];
    const definition = definitionId ? space.getObject(definitionId) : void 0;
    const shape = readSetUInt32(state, Property.noteTagShape) ?? (definition?.jcid === Jcid.noteTagSharedDefinition ? readUInt32Property(definition, Property.noteTagShape) : void 0);
    const checkable = shape !== void 0 && isCheckableShape(shape);
    tags.push({
      checkable,
      completed: (status & 1) !== 0,
      label: checkable ? void 0 : readString(definition, Property.noteTagLabel),
      shape
    });
  }
  return tags.length > 0 ? tags : void 0;
}
function isCheckableShape(shape) {
  if (shape >= 1 && shape <= 12) return true;
  if (shape === 28 || shape === 30 || shape === 32) return true;
  if (shape === 48 || shape === 50 || shape === 52) return true;
  if (shape === 69 || shape === 71 || shape === 73) return true;
  return shape >= 89 && shape <= 99;
}
function readSetUInt32(set, propertyId) {
  return findProperty(set, propertyId)?.scalarValue;
}
var MAX_TAGS_PER_PARAGRAPH = 9;
function buildListInfo(space, item) {
  let listNode;
  for (const listId of readReferences(item, Property.listNodes)) {
    const candidate = space.getObject(listId);
    if (candidate?.jcid === Jcid.numberListNode) listNode = candidate;
  }
  if (!listNode) return void 0;
  const format = readNumberListFormat(listNode);
  const marker = format.indexOf("\uFFFD");
  return {
    level: Math.max(0, (readUInt32Property(item, Property.outlineElementChildLevel) ?? 1) - 1),
    ordered: marker >= 0,
    format: format === "" ? void 0 : format
  };
}
function readNumberListFormat(listNode) {
  const data = readData(listNode, Property.numberListFormat);
  if (!data || data.length < 2) return "";
  const value = new TextDecoder("utf-16le").decode(data.subarray(0, data.length - data.length % 2));
  if (value.length === 0) return "";
  return value.slice(1, 1 + Math.min(value.charCodeAt(0), value.length - 1));
}
function buildTable(context, item, depth, path) {
  const { space } = context;
  const table = { kind: "table", rows: [] };
  for (const rowId of readReferences(item, Property.elementChildNodes)) {
    const rowItem = space.getObject(rowId);
    if (rowItem?.jcid !== Jcid.tableRowNode) continue;
    const row = { cells: [] };
    for (const cellId of readReferences(rowItem, Property.elementChildNodes)) {
      const cellItem = space.getObject(cellId);
      if (cellItem?.jcid !== Jcid.tableCellNode) continue;
      const children = [];
      for (const childId of readReferences(cellItem, Property.elementChildNodes)) {
        const child = buildElement(context, childId, depth + 1, path);
        if (child) children.push(child);
      }
      row.cells.push({ children });
    }
    table.rows.push(row);
  }
  return table;
}
function buildInk({ space, options, recognition }, container) {
  const inkDataId = readReferences(container, Property.inkData)[0];
  if (!inkDataId) return void 0;
  const inkData = space.getObject(inkDataId);
  if (inkData?.jcid !== Jcid.inkDataNode) return void 0;
  const scaleX = readFloat(container, Property.inkScalingX) ?? 1;
  const scaleY = readFloat(container, Property.inkScalingY) ?? 1;
  const ink = { kind: "ink", strokes: [] };
  const words = [];
  for (const strokeId of readReferences(inkData, Property.inkStrokes)) {
    const strokeObject = space.getObject(strokeId);
    if (strokeObject?.jcid !== Jcid.inkStrokeNode) continue;
    const stroke = decodeStroke(space, strokeObject, scaleX, scaleY, options);
    if (!stroke) continue;
    stroke.recognizedText = recognition.get(keyOf(strokeId));
    if (stroke.recognizedText) words.push(stroke.recognizedText);
    ink.strokes.push(stroke);
  }
  if (ink.strokes.length === 0) return void 0;
  if (words.length > 0) ink.recognizedText = words.join(" ");
  return ink;
}
function decodeStroke(space, source, scaleX, scaleY, options) {
  const properties = space.getObject(readReferences(source, Property.inkStrokeProperties)[0]);
  if (properties?.jcid !== Jcid.strokePropertiesNode) return void 0;
  const pathData = readData(source, Property.inkPath);
  if (!pathData) return void 0;
  const dimensions = decodeDimensions(readData(properties, Property.inkDimensions));
  const xIndex = indexOfDimension(dimensions, InkDimensionId.x);
  const yIndex = indexOfDimension(dimensions, InkDimensionId.y);
  if (xIndex < 0 || yIndex < 0) return void 0;
  const values = decodeSignedVector(pathData, Math.min(options.maxInkPathValues, pathData.length * 8));
  if (values.length === 0 || values.length % dimensions.length !== 0) return void 0;
  const pointCount = values.length / dimensions.length;
  const xs = decodePacketValues(values, xIndex * pointCount, pointCount);
  const ys = decodePacketValues(values, yIndex * pointCount, pointCount);
  const points = new Array(pointCount);
  for (let index = 0; index < pointCount; index++) {
    points[index] = {
      x: xs[index] * scaleX / NATIVE_UNITS_PER_HALF_INCH,
      y: ys[index] * scaleY / NATIVE_UNITS_PER_HALF_INCH
    };
  }
  const transparency = readUInt32Property(properties, Property.inkTransparency) ?? 0;
  return {
    points,
    color: decodeInkColor(readUInt32Property(properties, Property.inkColor)),
    width: Math.max(1e-6, (readFloat(properties, Property.inkWidth) ?? 1) * Math.abs(scaleX) / NATIVE_UNITS_PER_HALF_INCH),
    opacity: 1 - Math.min(255, transparency) / 255
  };
}
function collectRecognition(space, pageNode) {
  const recognition = /* @__PURE__ */ new Map();
  const rootId = readReferences(pageNode, Property.pageRecognizedTextContainer)[0];
  if (!rootId) return recognition;
  const visited = /* @__PURE__ */ new Set();
  const walk2 = (id, depth) => {
    if (depth > 8 || visited.has(keyOf(id))) return;
    visited.add(keyOf(id));
    const item = space.getObject(id);
    if (!item) return;
    if (item.jcid === Jcid.recognizedTextWord) {
      const [word] = decodeRecognitionAlternatives(readData(item, Property.recognizedText));
      const references = readData(item, Property.recognizedTextStrokeReferences);
      if (!word || !references) return;
      for (let offset = 0; offset + 20 <= references.length; offset += 20) {
        recognition.set(keyOf({ identifier: id.identifier, value: readUInt322(references, offset + 16), encodedLength: 17 }), word);
      }
      return;
    }
    for (const childId of readReferences(item, Property.recognizedTextChildNodes)) walk2(childId, depth + 1);
  };
  walk2(rootId, 0);
  return recognition;
}
function buildImage({ space, materializer }, item) {
  const image = {
    kind: "image",
    fileName: readString(item, Property.imageFilename)
  };
  for (const containerId of readReferences(item, Property.pictureContainer)) {
    const container = space.getObject(containerId);
    if (!container) continue;
    image.extension = readString(container, Property.fileDataExtension) ?? container.fileExtension;
    image.data = materializer.resolveFileData(container);
    break;
  }
  return image;
}
function buildEmbeddedFile({ space, materializer }, item) {
  const embedded = {
    kind: "embedded-file",
    fileName: readString(item, Property.embeddedFileName),
    sourcePath: readString(item, Property.sourceFilePath)
  };
  for (const containerId of readReferences(item, Property.embeddedFileContainer)) {
    const container = space.getObject(containerId);
    if (!container) continue;
    embedded.extension = readString(container, Property.fileDataExtension) ?? container.fileExtension;
    embedded.data = materializer.resolveFileData(container);
    break;
  }
  return embedded;
}
function collectText(element, into) {
  switch (element.kind) {
    case "paragraph":
      for (const run of element.runs) into.push(run.text);
      for (const child of element.children) collectText(child, into);
      break;
    case "outline":
      for (const child of element.children) collectText(child, into);
      break;
    case "table":
      for (const row of element.rows) {
        for (const cell of row.cells) {
          for (const child of cell.children) collectText(child, into);
        }
      }
      break;
    case "ink":
      if (element.recognizedText) into.push(element.recognizedText);
      break;
    default:
      break;
  }
}

// src/fsshttpb/binary.ts
var NIL_GUID = "00000000-0000-0000-0000-000000000000";
var NULL_EXTENDED_GUID = { identifier: NIL_GUID, value: 0 };
function isNullExtendedGuid(id) {
  return id.identifier === NIL_GUID && id.value === 0;
}
function extendedGuidKey(id) {
  return `${id.identifier}:${id.value}`;
}
var Cursor2 = class _Cursor {
  constructor(data, start = 0, limit = data.length) {
    this.data = data;
    this.limit = limit;
    this.position = start;
    if (limit > data.length) {
      throw new OneNoteFormatError(
        "ONENOTE_FSSHTTPB_RANGE",
        "A structure claims to extend past the end of the file.",
        start
      );
    }
  }
  position;
  get remaining() {
    return this.limit - this.position;
  }
  get atEnd() {
    return this.position >= this.limit;
  }
  /** A cursor over `length` bytes starting here, without copying. */
  sub(length) {
    this.ensure(length);
    return new _Cursor(this.data, this.position, this.position + length);
  }
  ensure(length) {
    if (length < 0 || this.position + length > this.limit) {
      throw new OneNoteFormatError(
        "ONENOTE_FSSHTTPB_RANGE",
        `Reading ${length} bytes would pass the end of the structure.`,
        this.position
      );
    }
  }
  skip(length) {
    this.ensure(length);
    this.position += length;
  }
  readUInt8() {
    this.ensure(1);
    return this.data[this.position++];
  }
  readUInt16() {
    this.ensure(2);
    const value = this.data[this.position] | this.data[this.position + 1] << 8;
    this.position += 2;
    return value;
  }
  readUInt32() {
    this.ensure(4);
    const { data, position } = this;
    const value = (data[position] | data[position + 1] << 8 | data[position + 2] << 16 | data[position + 3] << 24) >>> 0;
    this.position += 4;
    return value;
  }
  /** A view of the next `length` bytes. Shares memory with the file. */
  readBytes(length) {
    this.ensure(length);
    const view = this.data.subarray(this.position, this.position + length);
    this.position += length;
    return view;
  }
  /** A GUID stored in the little-endian mixed-endian layout Windows uses. */
  readGuid() {
    this.ensure(16);
    const hex = [];
    for (let index = 0; index < 16; index++) hex.push(this.data[this.position + index].toString(16).padStart(2, "0"));
    this.position += 16;
    const at = (...order) => order.map((index) => hex[index]).join("");
    return `${at(3, 2, 1, 0)}-${at(5, 4)}-${at(7, 6)}-${at(8, 9)}-${at(10, 11, 12, 13, 14, 15)}`;
  }
  /**
   * [MS-FSSHTTPB] 2.2.1.1 — a compact unsigned 64-bit integer.
   *
   * The low bits of the first byte say how wide the encoding is: the position
   * of its lowest set bit gives the width, and the value occupies everything
   * above that marker. A first byte of zero is the value zero, and 0x80
   * introduces a full 64-bit value in the eight bytes that follow.
   *
   * Returned as a JS number. Values above 2^53 cannot occur in a file this
   * reader will accept — every use is a length, a count or an ordinal bounded
   * by the file size — and one is rejected rather than silently rounded.
   */
  readCompactUint() {
    const first = this.data[this.position];
    if (this.position >= this.limit) {
      throw new OneNoteFormatError(
        "ONENOTE_FSSHTTPB_RANGE",
        "A compact integer begins past the end of the structure.",
        this.position
      );
    }
    if (first === 0) {
      this.position++;
      return 0;
    }
    if (first === 128) {
      this.ensure(9);
      this.position++;
      const low = this.readUInt32();
      const high = this.readUInt32();
      const value = high * 4294967296 + low;
      if (!Number.isSafeInteger(value)) {
        throw new OneNoteFormatError(
          "ONENOTE_FSSHTTPB_HUGE_INTEGER",
          "A compact integer exceeds the range this reader supports.",
          this.position - 9
        );
      }
      return value;
    }
    let width = 0;
    while (width < 7 && (first & 1 << width) === 0) width++;
    const bytes = width + 1;
    this.ensure(bytes);
    let raw = 0;
    for (let index = bytes - 1; index >= 0; index--) raw = raw * 256 + this.data[this.position + index];
    this.position += bytes;
    return Math.floor(raw / Math.pow(2, width + 1));
  }
  /**
   * [MS-FSSHTTPB] 2.2.1.7 — an Extended GUID: a GUID with an ordinal.
   *
   * Four widths carry non-overlapping ordinal ranges, plus a null form. The
   * type occupies the low bits of the first byte and the ordinal the rest, so
   * the GUID always follows on a byte boundary.
   */
  readExtendedGuid() {
    const start = this.position;
    const first = this.readUInt8();
    if (first === 0) return { ...NULL_EXTENDED_GUID };
    if ((first & 7) === 4) {
      const value = first >>> 3;
      return { identifier: this.readGuid(), value };
    }
    if ((first & 63) === 32) {
      const value = first >>> 6 | this.readUInt8() << 2;
      return { identifier: this.readGuid(), value };
    }
    if ((first & 127) === 64) {
      const value = first >>> 7 | this.readUInt16() << 1;
      return { identifier: this.readGuid(), value };
    }
    if (first === 128) {
      const value = this.readUInt32();
      return { identifier: this.readGuid(), value };
    }
    throw new OneNoteFormatError(
      "ONENOTE_FSSHTTPB_EXTENDED_GUID",
      `Byte 0x${first.toString(16)} does not begin any Extended GUID encoding.`,
      start
    );
  }
  /** [MS-FSSHTTPB] 2.2.1.10 — a cell identifier: a pair of Extended GUIDs. */
  readCellId() {
    return { first: this.readExtendedGuid(), second: this.readExtendedGuid() };
  }
  /** [MS-FSSHTTPB] 2.2.1.8 — a counted array of Extended GUIDs. */
  readExtendedGuidArray() {
    const count = this.readCompactUint();
    const items = [];
    for (let index = 0; index < count; index++) items.push(this.readExtendedGuid());
    return items;
  }
  /** [MS-FSSHTTPB] 2.2.1.11 — a counted array of cell identifiers. */
  readCellIdArray() {
    const count = this.readCompactUint();
    const items = [];
    for (let index = 0; index < count; index++) items.push(this.readCellId());
    return items;
  }
  /**
   * [MS-FSSHTTPB] 2.2.1.3 — a binary item: a compact length, then that many
   * bytes.
   *
   * The length is carried explicitly, so an item is not simply the rest of the
   * structure it sits in — reading it that way happens to work only when the
   * item is last, and silently absorbs whatever follows when it is not.
   */
  readBinaryItem() {
    return this.readBytes(this.readCompactUint());
  }
  /**
   * [MS-FSSHTTPB] 2.2.1.5 — a stream object header, in any of its four forms.
   *
   * The low two bits pick the form: 0 and 2 begin an object in 16 and 32 bits,
   * 1 and 3 end one in 8 and 16. A 32-bit start whose length field is all ones
   * carries its real length in a compact integer that follows.
   */
  readStreamObjectHeader() {
    const offset = this.position;
    const first = this.data[this.position];
    if (this.atEnd) {
      throw new OneNoteFormatError(
        "ONENOTE_FSSHTTPB_RANGE",
        "A stream object header begins past the end of the structure.",
        offset
      );
    }
    switch (first & 3) {
      case 0: {
        const header = this.readUInt16();
        return {
          kind: "start",
          compound: (header & 4) !== 0,
          type: header >>> 3 & 63,
          length: header >>> 9 & 127,
          offset,
          headerLength: 2
        };
      }
      case 2: {
        const header = this.readUInt32();
        const declared = header >>> 17 & 32767;
        const length = declared === 32767 ? this.readCompactUint() : declared;
        return {
          kind: "start",
          compound: (header & 4) !== 0,
          type: header >>> 3 & 16383,
          length,
          offset,
          headerLength: this.position - offset
        };
      }
      case 1: {
        const header = this.readUInt8();
        return { kind: "end", compound: false, type: header >>> 2, length: 0, offset, headerLength: 1 };
      }
      default: {
        const header = this.readUInt16();
        return { kind: "end", compound: false, type: header >>> 2, length: 0, offset, headerLength: 2 };
      }
    }
  }
};

// src/fsshttpb/data-element.ts
var DataElementType = /* @__PURE__ */ ((DataElementType2) => {
  DataElementType2[DataElementType2["StorageIndex"] = 1] = "StorageIndex";
  DataElementType2[DataElementType2["StorageManifest"] = 2] = "StorageManifest";
  DataElementType2[DataElementType2["CellManifest"] = 3] = "CellManifest";
  DataElementType2[DataElementType2["RevisionManifest"] = 4] = "RevisionManifest";
  DataElementType2[DataElementType2["ObjectGroup"] = 5] = "ObjectGroup";
  DataElementType2[DataElementType2["DataElementFragment"] = 6] = "DataElementFragment";
  DataElementType2[DataElementType2["ObjectDataBlob"] = 7] = "ObjectDataBlob";
  return DataElementType2;
})(DataElementType || {});
var NULL_SERIAL = { identifier: NIL_GUID, value: 0 };
var DATA_ELEMENT_TYPE = 1;
function readSerialNumber(cursor) {
  const marker = cursor.readUInt8();
  if (marker === 0) return { ...NULL_SERIAL };
  if (marker !== 128) {
    throw new OneNoteFormatError(
      "ONENOTE_FSSHTTPB_SERIAL_NUMBER",
      `Byte 0x${marker.toString(16)} does not begin a serial number.`,
      cursor.position - 1
    );
  }
  const identifier = cursor.readGuid();
  const low = cursor.readUInt32();
  const high = cursor.readUInt32();
  const value = high * 4294967296 + low;
  if (!Number.isSafeInteger(value)) {
    throw new OneNoteFormatError(
      "ONENOTE_FSSHTTPB_HUGE_INTEGER",
      "A serial number exceeds the range this reader supports.",
      cursor.position - 8
    );
  }
  return { identifier, value };
}
function readDataElementHeader(data, node) {
  if (node.type !== DATA_ELEMENT_TYPE) {
    throw new OneNoteFormatError(
      "ONENOTE_FSSHTTPB_NOT_DATA_ELEMENT",
      `Stream object type 0x${node.type.toString(16)} is not a data element.`,
      node.offset
    );
  }
  const cursor = new Cursor2(data, node.dataOffset, node.dataOffset + node.dataLength);
  const id = cursor.readExtendedGuid();
  const serial = readSerialNumber(cursor);
  const type = cursor.readCompactUint();
  const length = cursor.position - node.dataOffset;
  if (!cursor.atEnd) {
    throw new OneNoteFormatError(
      "ONENOTE_FSSHTTPB_DATA_ELEMENT_LENGTH",
      `A data element declares ${node.dataLength} bytes but its header uses ${length}.`,
      node.dataOffset
    );
  }
  if (!(type in DataElementType)) {
    throw new OneNoteFormatError(
      "ONENOTE_FSSHTTPB_DATA_ELEMENT_TYPE",
      `Data element type ${type} is not one this reader knows.`,
      node.dataOffset
    );
  }
  return { id, serial, type, length };
}

// src/fsshttpb/walk.ts
var MAX_DEPTH = 64;
var PACKAGING_START = 68;
function walk(data, from = PACKAGING_START) {
  const cursor = new Cursor2(data, from);
  const histogram = /* @__PURE__ */ new Map();
  const roots = [];
  let maxDepth = 0;
  const count = (type) => histogram.set(type, (histogram.get(type) ?? 0) + 1);
  const readOne = (into, depth) => {
    const mark = cursor.position;
    const header = cursor.readStreamObjectHeader();
    if (header.kind !== "start") {
      throw new OneNoteFormatError(
        "ONENOTE_FSSHTTPB_UNBALANCED",
        "The packaging structure does not begin with a start header.",
        mark
      );
    }
    count(header.type);
    const node = {
      type: header.type,
      compound: header.compound,
      offset: mark,
      dataOffset: mark + header.headerLength,
      dataLength: header.length,
      children: []
    };
    into.push(node);
    cursor.skip(header.length);
    if (header.compound) readChildren(node.children, depth + 1, header.type);
  };
  const readChildren = (into, depth, closing) => {
    if (depth > MAX_DEPTH) {
      throw new OneNoteFormatError(
        "ONENOTE_FSSHTTPB_DEPTH",
        "Stream objects nest deeper than this reader will follow.",
        cursor.position
      );
    }
    maxDepth = Math.max(maxDepth, depth);
    while (!cursor.atEnd) {
      const mark = cursor.position;
      const header = cursor.readStreamObjectHeader();
      if (header.kind === "end") {
        if (header.type !== closing) {
          throw new OneNoteFormatError(
            "ONENOTE_FSSHTTPB_UNBALANCED",
            `Object type 0x${closing.toString(16)} is closed by an end header for 0x${header.type.toString(16)}.`,
            mark
          );
        }
        return;
      }
      count(header.type);
      const node = {
        type: header.type,
        compound: header.compound,
        offset: mark,
        dataOffset: mark + header.headerLength,
        dataLength: header.length,
        children: []
      };
      into.push(node);
      cursor.skip(header.length);
      if (header.compound) readChildren(node.children, depth + 1, header.type);
    }
    throw new OneNoteFormatError(
      "ONENOTE_FSSHTTPB_UNBALANCED",
      `Object type 0x${closing.toString(16)} is never closed.`,
      cursor.position
    );
  };
  readOne(roots, 0);
  const end = cursor.position;
  for (let index = end; index < data.length; index++) {
    if (data[index] !== 0) {
      throw new OneNoteFormatError(
        "ONENOTE_FSSHTTPB_TRAILING",
        "The bytes after the packaging object are not padding.",
        index
      );
    }
  }
  return { roots, start: from, end, trailing: data.length - end, histogram, maxDepth };
}

// src/fsshttpb/package.ts
function readExact(data, node, read) {
  const cursor = new Cursor2(data, node.dataOffset, node.dataOffset + node.dataLength);
  const value = read(cursor);
  if (!cursor.atEnd) {
    throw new OneNoteFormatError(
      "ONENOTE_FSSHTTPB_STRUCTURE_LENGTH",
      `Stream object 0x${node.type.toString(16)} declares ${node.dataLength} bytes but its fields used ${cursor.position - node.dataOffset}.`,
      node.dataOffset
    );
  }
  return value;
}
function expect(node, type, what) {
  if (!node || node.type !== type) {
    throw new OneNoteFormatError(
      "ONENOTE_FSSHTTPB_MISSING_STRUCTURE",
      `Expected ${what} (0x${type.toString(16)}) but found ` + (node ? `0x${node.type.toString(16)}` : "nothing") + ".",
      node?.offset
    );
  }
  return node;
}
function readSerial(cursor) {
  const marker = cursor.readUInt8();
  if (marker === 0) return { identifier: "00000000-0000-0000-0000-000000000000", value: 0 };
  if (marker !== 128) {
    throw new OneNoteFormatError(
      "ONENOTE_FSSHTTPB_SERIAL_NUMBER",
      `Byte 0x${marker.toString(16)} does not begin a serial number.`,
      cursor.position - 1
    );
  }
  const identifier = cursor.readGuid();
  const low = cursor.readUInt32();
  const high = cursor.readUInt32();
  return { identifier, value: high * 4294967296 + low };
}
function readStorageIndex(data, element) {
  const index = { manifestMappings: [], cellMappings: [], revisionMappings: [] };
  for (const child of element.children) {
    switch (child.type) {
      case 17 /* StorageIndexManifestMapping */:
        index.manifestMappings.push(readExact(data, child, (cursor) => ({
          id: cursor.readExtendedGuid(),
          serial: readSerial(cursor)
        })));
        break;
      case 14 /* StorageIndexCellMapping */:
        index.cellMappings.push(readExact(data, child, (cursor) => ({
          cell: cursor.readCellId(),
          id: cursor.readExtendedGuid(),
          serial: readSerial(cursor)
        })));
        break;
      case 13 /* StorageIndexRevisionMapping */:
        index.revisionMappings.push(readExact(data, child, (cursor) => ({
          revision: cursor.readExtendedGuid(),
          id: cursor.readExtendedGuid(),
          serial: readSerial(cursor)
        })));
        break;
      default:
        throw new OneNoteFormatError(
          "ONENOTE_FSSHTTPB_MISSING_STRUCTURE",
          `A storage index cannot hold a 0x${child.type.toString(16)}.`,
          child.offset
        );
    }
  }
  return index;
}
function readStorageManifest(data, element) {
  const schemaNode = expect(element.children.at(0), 12 /* StorageManifestSchemaGuid */, "a schema GUID");
  const schema = readExact(data, schemaNode, (cursor) => cursor.readGuid());
  const roots = element.children.slice(1).map((child) => readExact(
    data,
    expect(child, 7 /* StorageManifestRootDeclare */, "a root declaration"),
    (cursor) => ({ root: cursor.readExtendedGuid(), cell: cursor.readCellId() })
  ));
  return { schema, roots };
}
function readCellManifest(data, element) {
  const node = expect(element.children.at(0), 11 /* CellManifestCurrentRevision */, "a current revision");
  return { currentRevision: readExact(data, node, (cursor) => cursor.readExtendedGuid()) };
}
function readRevisionManifest(data, element) {
  const head = expect(element.children.at(0), 26 /* RevisionManifest */, "a revision manifest");
  const { revision, baseRevision } = readExact(data, head, (cursor) => ({
    revision: cursor.readExtendedGuid(),
    baseRevision: cursor.readExtendedGuid()
  }));
  const manifest = { revision, baseRevision, roots: [], objectGroups: [] };
  for (const child of element.children.slice(1)) {
    switch (child.type) {
      case 10 /* RevisionManifestRootDeclare */:
        manifest.roots.push(readExact(data, child, (cursor) => ({
          root: cursor.readExtendedGuid(),
          object: cursor.readExtendedGuid()
        })));
        break;
      case 25 /* RevisionManifestObjectGroupReference */:
        manifest.objectGroups.push(readExact(data, child, (cursor) => cursor.readExtendedGuid()));
        break;
      default:
        throw new OneNoteFormatError(
          "ONENOTE_FSSHTTPB_MISSING_STRUCTURE",
          `A revision manifest cannot hold a 0x${child.type.toString(16)}.`,
          child.offset
        );
    }
  }
  return manifest;
}
function readObjectGroup(data, element) {
  const group = { declarations: [], data: [] };
  for (const section of element.children) {
    if (section.type === 29 /* ObjectGroupDeclarations */) {
      for (const child of section.children) {
        const isBlobReference = child.type === 5 /* ObjectGroupObjectDeclareBlobReference */;
        if (!isBlobReference) expect(child, 24 /* ObjectGroupObjectDeclare */, "an object declaration");
        group.declarations.push(readExact(data, child, (cursor) => ({
          object: cursor.readExtendedGuid(),
          // A blob reference names its payload element instead of
          // carrying a size, so the two forms differ by one field each.
          blob: isBlobReference ? cursor.readExtendedGuid() : void 0,
          partition: cursor.readCompactUint(),
          dataSize: isBlobReference ? void 0 : cursor.readCompactUint(),
          objectReferenceCount: cursor.readCompactUint(),
          cellReferenceCount: cursor.readCompactUint()
        })));
      }
      continue;
    }
    if (section.type === 30 /* ObjectGroupData */) {
      for (const child of section.children) {
        const isBlobReference = child.type === 28 /* ObjectGroupObjectDataBlobReference */;
        if (!isBlobReference) expect(child, 22 /* ObjectGroupObjectData */, "object data");
        group.data.push(readExact(data, child, (cursor) => ({
          // The object's identity is not repeated here; it comes from
          // the declaration at the same position.
          objectReferences: cursor.readExtendedGuidArray(),
          cellReferences: cursor.readCellIdArray(),
          data: isBlobReference ? void 0 : cursor.readBinaryItem(),
          blob: isBlobReference ? cursor.readExtendedGuid() : void 0
        })));
      }
      continue;
    }
    throw new OneNoteFormatError(
      "ONENOTE_FSSHTTPB_MISSING_STRUCTURE",
      `An object group cannot hold a 0x${section.type.toString(16)}.`,
      section.offset
    );
  }
  return group;
}
function readDataElementPackage(data) {
  const root = walk(data).roots[0];
  const packageNode = expect(root.children.at(0), 21 /* DataElementPackage */, "a data element package");
  let storageIndex;
  let storageManifest;
  const cellManifests = /* @__PURE__ */ new Map();
  const revisionManifests = /* @__PURE__ */ new Map();
  const objectGroups = /* @__PURE__ */ new Map();
  const blobs = /* @__PURE__ */ new Map();
  for (const element of packageNode.children) {
    const header = readDataElementHeader(data, element);
    const key = extendedGuidKey(header.id);
    switch (header.type) {
      case 1 /* StorageIndex */:
        storageIndex = readStorageIndex(data, element);
        break;
      case 2 /* StorageManifest */:
        storageManifest = readStorageManifest(data, element);
        break;
      case 3 /* CellManifest */:
        cellManifests.set(key, readCellManifest(data, element));
        break;
      case 4 /* RevisionManifest */:
        revisionManifests.set(key, readRevisionManifest(data, element));
        break;
      case 5 /* ObjectGroup */:
        objectGroups.set(key, readObjectGroup(data, element));
        break;
      case 7 /* ObjectDataBlob */: {
        const payload = expect(element.children.at(0), 2 /* ObjectDataBlob */, "a BLOB payload");
        blobs.set(key, data.subarray(payload.dataOffset, payload.dataOffset + payload.dataLength));
        break;
      }
      default:
        break;
    }
  }
  if (!storageIndex) {
    throw new OneNoteFormatError(
      "ONENOTE_FSSHTTPB_NO_STORAGE_INDEX",
      "The data element package has no storage index."
    );
  }
  if (!storageManifest) {
    throw new OneNoteFormatError(
      "ONENOTE_FSSHTTPB_NO_STORAGE_MANIFEST",
      "The data element package has no storage manifest."
    );
  }
  return { storageIndex, storageManifest, cellManifests, revisionManifests, objectGroups, blobs };
}

// src/fsshttpb/object-graph.ts
var DEFAULT_CONTEXT_GUID = "84defab9-aaa3-4a0d-a3a8-520c77ac7073";
function isDefaultContext(id) {
  return isNullExtendedGuid(id) || id.identifier === DEFAULT_CONTEXT_GUID && id.value === 1;
}
function toStoreGuid(id) {
  return { identifier: id.identifier, value: id.value };
}
function readReferenceStream(data, position) {
  if (position + 4 > data.length) {
    throw new OneNoteFormatError(
      "ONENOTE_FSSHTTPB_OBJECT_STREAM",
      "A property reference stream is truncated.",
      position
    );
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const header = view.getUint32(position, true);
  const count = header & 16777215;
  if ((header & 1056964608) !== 0 || position + 4 + count * 4 > data.length) {
    throw new OneNoteFormatError(
      "ONENOTE_FSSHTTPB_OBJECT_STREAM",
      "A property reference stream is invalid or longer than the object data.",
      position
    );
  }
  const compactIds = [];
  for (let index = 0; index < count; index++) compactIds.push(view.getUint32(position + 4 + index * 4, true));
  return {
    stream: {
      compactIds,
      extendedStreamsPresent: (header & 1073741824) !== 0,
      osidStreamNotPresent: (header & 2147483648) !== 0
    },
    next: position + 4 + count * 4
  };
}
function addMappings(into, compactIds, extendedIds, offset, kind) {
  if (compactIds.length !== extendedIds.length) {
    throw new OneNoteFormatError(
      "ONENOTE_FSSHTTPB_MAPPING_COUNT",
      `The ${kind} CompactID and Extended GUID arrays have different lengths.`,
      offset
    );
  }
  for (let index = 0; index < compactIds.length; index++) {
    const compact = compactIds[index];
    const extended = extendedIds[index];
    if (compact === 0 && isNullExtendedGuid(extended)) continue;
    const globalIndex = compact >>> 8;
    const ordinal = compact & 255;
    if (globalIndex >= 16777215 || extended.identifier === NIL_GUID || extended.value !== ordinal) {
      throw new OneNoteFormatError(
        "ONENOTE_FSSHTTPB_MAPPING",
        `A ${kind} mapping pairs a CompactID with an incompatible Extended GUID.`,
        offset
      );
    }
    const existing = into.get(globalIndex);
    if (existing !== void 0 && existing !== extended.identifier) {
      throw new OneNoteFormatError(
        "ONENOTE_FSSHTTPB_MAPPING",
        "One CompactID global index maps to two different GUIDs.",
        offset
      );
    }
    into.set(globalIndex, extended.identifier);
  }
}
function buildGlobalIds(item, cell) {
  const data = item.propertyData;
  const mappings = /* @__PURE__ */ new Map();
  const { stream: oids, next } = readReferenceStream(data, 0);
  let osids;
  let contexts;
  if (!oids.osidStreamNotPresent) {
    const read = readReferenceStream(data, next);
    osids = read.stream;
    if (osids.extendedStreamsPresent) contexts = readReferenceStream(data, read.next).stream;
  }
  const osidReferences = item.cellReferences.filter((reference) => extendedGuidKey(reference.first) === extendedGuidKey(cell.first)).map((reference) => reference.second);
  const contextReferences = item.cellReferences.filter((reference) => extendedGuidKey(reference.first) !== extendedGuidKey(cell.first)).map((reference) => reference.first);
  addMappings(mappings, oids.compactIds, item.objectReferences, item.offset, "object");
  if (osids) addMappings(mappings, osids.compactIds, osidReferences, item.offset, "object-space");
  if (contexts) addMappings(mappings, contexts.compactIds, contextReferences, item.offset, "context");
  return mappings;
}
function accumulate(group, into, order) {
  for (let index = 0; index < group.declarations.length; index++) {
    const declaration = group.declarations[index];
    const data = group.data[index];
    if (!data) continue;
    const key = extendedGuidKey(declaration.object);
    let item = into.get(key);
    if (!item) {
      item = {
        id: declaration.object,
        jcid: 0,
        objectReferences: [],
        cellReferences: [],
        referenceCount: 0,
        offset: 0
      };
      into.set(key, item);
      order.push(item);
    }
    item.referenceCount = Math.max(
      item.referenceCount,
      declaration.objectReferenceCount + declaration.cellReferenceCount
    );
    switch (declaration.partition) {
      case 4 /* ObjectMetadata */: {
        if (data.data?.length !== 4) {
          throw new OneNoteFormatError(
            "ONENOTE_FSSHTTPB_JCID",
            "Object metadata is not a four-byte type code."
          );
        }
        const bytes = data.data;
        item.jcid = (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
        break;
      }
      case 1 /* ObjectData */:
        item.propertyData = data.data;
        item.objectReferences = data.objectReferences;
        item.cellReferences = data.cellReferences;
        break;
      case 2 /* ObjectFileData */:
        item.blob = data.blob ?? declaration.blob;
        break;
      default:
        break;
    }
  }
}
function buildObjectGraph(data, options = DEFAULT_READER_OPTIONS, parsed = readDataElementPackage(data)) {
  const working = /* @__PURE__ */ new Map();
  const byRevisionId = /* @__PURE__ */ new Map();
  for (const [elementKey, manifest] of parsed.revisionManifests) {
    const revision = {
      manifest: {
        id: toStoreGuid(manifest.revision),
        dependencyId: isNullExtendedGuid(manifest.baseRevision) ? void 0 : toStoreGuid(manifest.baseRevision),
        role: 0,
        isEncrypted: false,
        rootObjects: manifest.roots.map((root) => ({
          objectId: toStoreGuid(root.object),
          role: root.root.value
        })),
        roleAssociations: []
      },
      objectGroups: manifest.objectGroups
    };
    working.set(elementKey, revision);
    byRevisionId.set(extendedGuidKey(manifest.revision), revision);
  }
  const revisionElementByRevisionId = new Map(
    parsed.storageIndex.revisionMappings.map((mapping) => [extendedGuidKey(mapping.revision), mapping.id])
  );
  let order = 0;
  for (const mapping of parsed.storageIndex.cellMappings) {
    const cellManifest = parsed.cellManifests.get(extendedGuidKey(mapping.id));
    if (!cellManifest) continue;
    const elementId = revisionElementByRevisionId.get(extendedGuidKey(cellManifest.currentRevision));
    if (!elementId) continue;
    const current = working.get(extendedGuidKey(elementId));
    if (!current) continue;
    assignCell(current, mapping.cell, byRevisionId, order++);
  }
  const graph = { revisions: [], objects: [], fileDataObjects: [] };
  const placed = /* @__PURE__ */ new Set();
  for (const revision of working.values()) {
    if (!revision.manifest.objectSpaceId) continue;
    graph.revisions.push(revision.manifest);
  }
  for (const revision of working.values()) {
    if (!revision.manifest.objectSpaceId || !revision.cell) continue;
    const objects = /* @__PURE__ */ new Map();
    const ordered = [];
    for (const groupId of revision.objectGroups) {
      const group = parsed.objectGroups.get(extendedGuidKey(groupId));
      if (group) accumulate(group, objects, ordered);
    }
    for (const item of ordered) {
      if (graph.objects.length >= options.maxObjects) {
        throw new OneNoteFormatError("ONENOTE_OBJECT_LIMIT", "The object declaration limit was exceeded.");
      }
      const record = {
        id: toStoreGuid(item.id),
        jcid: item.jcid,
        referenceCount: item.referenceCount,
        revisionId: revision.manifest.id,
        // An object seen in an earlier revision is that revision's,
        // carried forward rather than declared afresh.
        isRevision: placed.has(keyOf(toStoreGuid(item.id)))
      };
      placed.add(keyOf(toStoreGuid(item.id)));
      if (item.propertyData) {
        const globalIds = buildGlobalIds(item, revision.cell);
        record.propertySet = readPropertySet(item.propertyData, globalIds, options, 0);
        record.fileDataReference = readString(record, Property.fileDataReference);
        record.fileExtension = readString(record, Property.fileDataExtension);
      }
      graph.objects.push(record);
      const payload = item.blob && parsed.blobs.get(extendedGuidKey(item.blob));
      const referenceId = fileDataId(record.fileDataReference);
      if (payload && referenceId && !graph.fileDataObjects.some((entry) => entry.referenceId === referenceId)) {
        graph.fileDataObjects.push({ referenceId, payload });
      }
    }
  }
  return graph;
}
function fileDataId(reference) {
  if (!reference || !reference.toLowerCase().startsWith("<ifndf>")) return void 0;
  return reference.slice(7).trim().replace(/\0+$/, "").replace(/^\{|\}$/g, "").toLowerCase();
}
function assignCell(head, cell, byRevisionId, order) {
  const visited = /* @__PURE__ */ new Set();
  let revision = head;
  let isCurrent = true;
  while (revision && !visited.has(keyOf(revision.manifest.id))) {
    visited.add(keyOf(revision.manifest.id));
    revision.cell = cell;
    revision.manifest.objectSpaceId = toStoreGuid(cell.second);
    revision.manifest.contextId = isDefaultContext(cell.first) ? void 0 : toStoreGuid(cell.first);
    if (isCurrent) {
      revision.manifest.role = 1;
      revision.manifest.roleAssociations.push({
        contextId: revision.manifest.contextId,
        role: 1,
        order
      });
      isCurrent = false;
    }
    const dependency = revision.manifest.dependencyId;
    revision = dependency ? byRevisionId.get(keyOf(dependency)) : void 0;
  }
}

// src/read-section.ts
var SECTION_EXTENSION = /\.one$/i;
function titleOf(name) {
  return name.replace(/^.*[\\/]/, "").replace(SECTION_EXTENSION, "");
}
function groupsOf(name) {
  const parts = name.split(/[\\/]/);
  parts.pop();
  return parts.filter((part) => part !== "" && part !== ".");
}
function isSection(name) {
  return SECTION_EXTENSION.test(name);
}
function isPackage(data) {
  return data.length >= 4 && data[0] === 77 && data[1] === 83 && data[2] === 67 && data[3] === 70;
}
function readSection(data, options = DEFAULT_READER_OPTIONS) {
  const header = readFileHeader(data, data.length, options);
  if (header.storageFormat === "file-synchronization-package") {
    return mapSection({
      header,
      root: { id: 0, nodes: [] },
      lists: [],
      graph: buildObjectGraph(data, options)
    }, options);
  }
  return mapSection(readRevisionStore(data, options), options);
}
function readSections(data, fallbackName, wanted, limits = DEFAULT_CABINET_LIMITS, options = DEFAULT_READER_OPTIONS) {
  if (isCompoundFile(data)) {
    const kind = inspectOnex(data);
    throw new OneNoteFormatError(
      kind === "rights-protected" ? "ONENOTE_ONEX_PROTECTED" : "ONENOTE_ONEX_UNSUPPORTED",
      kind === "rights-protected" ? "The .onex file is rights-protected and its contents are encrypted." : "The .onex file is a compound document this importer does not recognise."
    );
  }
  if (!isPackage(data)) {
    return [{
      name: fallbackName,
      title: titleOf(fallbackName),
      groups: [],
      read: () => readSection(data, options)
    }];
  }
  return readCabinet(data, limits, (name) => isSection(name) && (!wanted || wanted.has(name))).map((entry) => ({
    name: entry.name,
    title: titleOf(entry.name),
    groups: groupsOf(entry.name),
    read: () => readSection(entry.data, options)
  }));
}
function listSections(data, fallbackName, limits = DEFAULT_CABINET_LIMITS) {
  if (!isPackage(data)) return [{ name: fallbackName, title: titleOf(fallbackName), groups: [] }];
  return readCabinetIndex(data, limits).entries.filter((entry) => isSection(entry.name)).map((entry) => ({ name: entry.name, title: titleOf(entry.name), groups: groupsOf(entry.name) }));
}

// src/convert-file.ts
var Workspace = class {
  names = new NameRegistry();
  /** Identical bytes appear repeatedly across a notebook; one copy is enough. */
  byContent = /* @__PURE__ */ new Map();
};
var DEFAULTS = {
  attachmentsDir: "attachments",
  writeAttachments: true,
  includeDeleted: false,
  nestSubpages: true,
  frontmatter: true
};
function join(...parts) {
  return parts.filter((part) => part !== void 0 && part !== "").join("/");
}
function describe(error) {
  return error instanceof OneNoteFormatError ? error.kind : "unknown";
}
function failure(name, error) {
  return {
    name,
    kind: describe(error),
    code: error instanceof OneNoteFormatError ? error.code : void 0,
    message: error instanceof Error ? error.message : String(error)
  };
}
function scalar(value) {
  return JSON.stringify(value);
}
function frontMatterFor(page, section, notebook, groups) {
  const lines = [
    "---",
    `title: ${scalar(page.title)}`,
    `source: onenote`,
    `onenote-id: ${scalar(page.id)}`,
    `section: ${scalar(section)}`
  ];
  if (notebook) lines.push(`notebook: ${scalar(notebook)}`);
  if (groups.length > 0) lines.push(`section-group: ${scalar(groups.join("/"))}`);
  if (page.createdUtc) lines.push(`created: ${page.createdUtc.toISOString()}`);
  if (page.lastModifiedUtc) lines.push(`updated: ${page.lastModifiedUtc.toISOString()}`);
  if (page.isConflictPage) lines.push("conflict: true");
  if (page.isDeleted) lines.push("deleted: true");
  lines.push("---", "");
  return lines.join("\n");
}
function inspect(data, fileName) {
  return listSections(data, fileName);
}
async function convertFile(data, fileName, sink, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const report = { input: fileName, notes: [], attachments: [], skipped: [], errors: [], cancelled: false };
  const { names, byContent } = opts.workspace ?? new Workspace();
  let entries;
  try {
    entries = readSections(data, fileName, opts.sections?.size ? opts.sections : void 0);
  } catch (error) {
    report.errors.push(failure(fileName, error));
    return report;
  }
  const notebook = entries.length > 1 || entries[0]?.groups.length ? baseName(fileName) : void 0;
  let index = 0;
  for (const entry of entries) {
    if (opts.isCancelled?.()) {
      report.cancelled = true;
      return report;
    }
    opts.onProgress?.({ kind: "section", name: entry.title, index: ++index, total: entries.length });
    let section;
    try {
      section = entry.read();
    } catch (error) {
      report.errors.push(failure(entry.title, error));
      continue;
    }
    const groups = entry.groups.map((group) => sanitizeFileName(group));
    const parent = join(notebook && sanitizeFileName(notebook), ...groups);
    const sectionName = names.claim(parent, sanitizeFileName(section.name || entry.title));
    const sectionDir = join(parent, sectionName);
    await convertSection(section, sectionDir, {
      opts,
      sink,
      names,
      byContent,
      report,
      label: section.name || entry.title,
      notebook,
      groups: entry.groups
    });
  }
  return report;
}
async function convertSection(section, sectionDir, ctx) {
  const { opts, sink, names, report } = ctx;
  const levels = [sectionDir];
  const pages = section.pages.filter((page) => opts.includeDeleted || !page.isDeleted);
  let done = 0;
  for (const page of pages) {
    if (opts.isCancelled?.()) {
      report.cancelled = true;
      return;
    }
    const depth = opts.nestSubpages ? Math.min(page.level, levels.length - 1) : 0;
    levels.length = depth + 1;
    const target = levels[depth];
    const title = sanitizeFileName(page.title);
    const noteName = names.claim(target, `${title}.md`);
    const notePath = join(target, noteName);
    const stem = noteName.replace(/\.md$/, "");
    opts.onProgress?.({ kind: "note", name: stem, index: ++done, total: pages.length });
    try {
      const attachmentsDir = join(target, opts.attachmentsDir);
      const converted = await convertPage(page, {
        noteName: stem,
        isCancelled: opts.isCancelled,
        resolveInternalLink: (linked) => sanitizeFileName(linked),
        onSkipped: (item, reason) => report.skipped.push({ page: stem, item, reason }),
        saveAttachment: async (bytes, suggested) => {
          if (!opts.writeAttachments) return null;
          return saveAttachment(bytes, suggested, attachmentsDir, opts.attachmentsDir, ctx);
        }
      });
      const front = opts.frontmatter ? frontMatterFor(page, ctx.label, ctx.notebook, ctx.groups) : "";
      const body = converted.markdown.endsWith("\n") ? converted.markdown : `${converted.markdown}
`;
      await sink.write(notePath, new TextEncoder().encode(front + body));
      report.notes.push(notePath);
    } catch (error) {
      report.errors.push(failure(stem, error));
    }
    levels.push(join(target, stem));
  }
}
async function saveAttachment(bytes, suggested, attachmentsDir, linkPrefix, ctx) {
  if (!extensionFromName(suggested)) {
    const sniffed = extensionFromBytes(bytes);
    if (sniffed) suggested = `${suggested}.${sniffed}`;
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  const key = `${attachmentsDir}\0${digest}`;
  const existing = ctx.byContent.get(key);
  if (existing) return existing;
  const fileName = ctx.names.claim(attachmentsDir, sanitizeFileName(suggested));
  const path = join(attachmentsDir, fileName);
  await ctx.sink.write(path, bytes);
  ctx.report.attachments.push(path);
  const resolved = { path: join(linkPrefix, fileName), name: fileName };
  ctx.byContent.set(key, resolved);
  return resolved;
}
function baseName(fileName) {
  return fileName.replace(/^.*[\\/]/, "").replace(/\.(one|onepkg|onex)$/i, "");
}

// src/sinks.ts
import * as nodeFs from "node:fs";
import * as nodePath from "node:path";
var FsSink = class {
  constructor(root, overwrite) {
    this.root = root;
    this.overwrite = overwrite;
  }
  made = /* @__PURE__ */ new Set();
  async write(path, data) {
    const full = nodePath.join(this.root, ...path.split("/"));
    const dir = nodePath.dirname(full);
    if (!this.made.has(dir)) {
      nodeFs.mkdirSync(dir, { recursive: true });
      this.made.add(dir);
    }
    nodeFs.writeFileSync(full, data, { flag: this.overwrite ? "w" : "wx" });
  }
};
var NullSink = class {
  bytes = 0;
  async write(_path, data) {
    this.bytes += data.byteLength;
  }
};

// src/cli.ts
var USAGE = `one2md \u2014 convert OneNote .one / .onepkg files to Markdown

Usage:
  one2md <input...> [options]

Inputs may be .one or .onepkg files, or folders to search for them.

Options:
  -o, --out <dir>        Where to write (default: ./out)
      --list             List the sections in each input and exit
      --sections <a,b>   Only convert these sections of a .onepkg (by entry name)
      --dry-run          Report what would be written without writing it
      --overwrite        Replace existing files instead of failing on them
      --no-attachments   Leave images and embedded files out
      --attachments <d>  Folder name for assets beside a note (default: attachments)
      --no-frontmatter   Omit the YAML header
      --no-nest          Write subpages beside their parent, not in a folder
      --include-deleted  Include pages still in OneNote's recycle bin
      --json             Emit a machine-readable report on stdout
  -q, --quiet            Only report failures
  -h, --help             Show this message

Exit codes:
  0  every input converted
  1  at least one input or section failed
  2  bad usage
`;
var UsageError = class extends Error {
};
function parseArgs(argv) {
  const options = {
    inputs: [],
    out: "out",
    list: false,
    dryRun: false,
    overwrite: false,
    attachments: true,
    attachmentsDir: "attachments",
    frontmatter: true,
    nest: true,
    includeDeleted: false,
    json: false,
    quiet: false
  };
  const next = (flag, value) => {
    if (value === void 0) throw new UsageError(`${flag} needs a value`);
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "-o":
      case "--out":
        options.out = next(arg, argv[++i]);
        break;
      case "--list":
        options.list = true;
        break;
      case "--sections":
        options.sections = new Set(next(arg, argv[++i]).split(",").map((name) => name.trim()).filter(Boolean));
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--overwrite":
        options.overwrite = true;
        break;
      case "--no-attachments":
        options.attachments = false;
        break;
      case "--attachments":
        options.attachmentsDir = next(arg, argv[++i]);
        break;
      case "--no-frontmatter":
        options.frontmatter = false;
        break;
      case "--no-nest":
        options.nest = false;
        break;
      case "--include-deleted":
        options.includeDeleted = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "-q":
      case "--quiet":
        options.quiet = true;
        break;
      case "-h":
      case "--help":
        process.stdout.write(USAGE);
        process.exit(0);
        break;
      default:
        if (arg.startsWith("-")) throw new UsageError(`Unknown option ${arg}`);
        options.inputs.push(arg);
    }
  }
  if (options.inputs.length === 0) throw new UsageError("No input files given");
  return options;
}
var EXTENSIONS = /\.(one|onepkg|onex)$/i;
function collect(inputs) {
  const found = [];
  const walk2 = (current) => {
    const stat = nodeFs2.statSync(current);
    if (!stat.isDirectory()) {
      found.push(current);
      return;
    }
    for (const entry of nodeFs2.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = nodePath2.join(current, entry.name);
      if (entry.isDirectory()) walk2(full);
      else if (EXTENSIONS.test(entry.name)) found.push(full);
    }
  };
  for (const input of inputs) {
    if (!nodeFs2.existsSync(input)) throw new UsageError(`No such file or folder: ${input}`);
    walk2(input);
  }
  return found;
}
var REASONS = {
  unsupported: "this file uses a OneNote feature the reader does not implement",
  protected: "the file is rights-protected, so its contents are encrypted",
  malformed: "the file is damaged or is not a OneNote section",
  limit: "the file exceeds a safety limit for its size or structure",
  unknown: "unexpected failure"
};
function log(quiet, line) {
  if (!quiet) process.stderr.write(`${line}
`);
}
async function main(argv) {
  const options = parseArgs(argv);
  const files = collect(options.inputs);
  if (files.length === 0) {
    throw new UsageError("No .one or .onepkg files found in the given paths");
  }
  if (options.list) {
    const listing = files.map((file) => {
      try {
        const data = new Uint8Array(nodeFs2.readFileSync(file));
        return { file, sections: inspect(data, nodePath2.basename(file)) };
      } catch (error) {
        return { file, sections: [], error: error instanceof Error ? error.message : String(error) };
      }
    });
    if (options.json) process.stdout.write(`${JSON.stringify(listing, null, 2)}
`);
    else {
      for (const item of listing) {
        process.stdout.write(`${item.file}
`);
        if (item.error) process.stdout.write(`  ! ${item.error}
`);
        for (const section of item.sections) {
          process.stdout.write(`  ${[...section.groups, section.title].join(" / ")}	${section.name}
`);
        }
      }
    }
    return listing.some((item) => item.error) ? 1 : 0;
  }
  const reports = [];
  const workspace = new Workspace();
  for (const file of files) {
    const name = nodePath2.basename(file);
    log(options.quiet, `Reading ${file}`);
    let data;
    try {
      data = new Uint8Array(nodeFs2.readFileSync(file));
    } catch (error) {
      reports.push({
        input: file,
        notes: [],
        attachments: [],
        skipped: [],
        cancelled: false,
        errors: [{ name, kind: "unknown", message: error instanceof Error ? error.message : String(error) }]
      });
      continue;
    }
    const sink = options.dryRun ? new NullSink() : new FsSink(options.out, options.overwrite);
    const report = await convertFile(data, name, sink, {
      attachmentsDir: options.attachmentsDir,
      writeAttachments: options.attachments,
      includeDeleted: options.includeDeleted,
      nestSubpages: options.nest,
      frontmatter: options.frontmatter,
      sections: options.sections,
      workspace,
      onProgress: (event) => {
        if (event.kind === "section") log(options.quiet, `  section ${event.index}/${event.total}: ${event.name}`);
      }
    });
    report.input = file;
    reports.push(report);
    log(options.quiet, `  ${report.notes.length} notes, ${report.attachments.length} attachments` + (report.skipped.length ? `, ${report.skipped.length} skipped` : "") + (report.errors.length ? `, ${report.errors.length} failed` : ""));
    for (const error of report.errors) {
      process.stderr.write(`  ! ${error.name}: ${REASONS[error.kind] ?? error.kind} \u2014 ${error.message}
`);
    }
  }
  const failed = reports.some((report) => report.errors.length > 0);
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ok: !failed, out: options.out, dryRun: options.dryRun, reports }, null, 2)}
`);
  } else if (!options.quiet) {
    const notes = reports.reduce((sum, report) => sum + report.notes.length, 0);
    const attachments = reports.reduce((sum, report) => sum + report.attachments.length, 0);
    process.stdout.write(`${options.dryRun ? "Would write" : "Wrote"} ${notes} notes and ${attachments} attachments${options.dryRun ? "" : ` to ${options.out}`}
`);
  }
  return failed ? 1 : 0;
}
main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error) => {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}

${USAGE}`);
      process.exit(2);
    }
    if (error instanceof OneNoteFormatError) {
      process.stderr.write(`${error.message}
`);
      process.exit(1);
    }
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}
`);
    process.exit(1);
  }
);
