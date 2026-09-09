#!/usr/bin/env node

// src/cli.ts
import * as nodeFs5 from "node:fs";
import * as nodePath4 from "node:path";

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
  const format2 = readNumberListFormat(listNode);
  const marker = format2.indexOf("\uFFFD");
  return {
    level: Math.max(0, (readUInt32Property(item, Property.outlineElementChildLevel) ?? 1) - 1),
    ordered: marker >= 0,
    format: format2 === "" ? void 0 : format2
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
      const references2 = readData(item, Property.recognizedTextStrokeReferences);
      if (!word || !references2) return;
      for (let offset = 0; offset + 20 <= references2.length; offset += 20) {
        recognition.set(keyOf({ identifier: id.identifier, value: readUInt322(references2, offset + 16), encodedLength: 17 }), word);
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
  constructor(data, start = 0, limit = data.length, base = 0) {
    this.data = data;
    this.limit = limit;
    this.base = base;
    this.position = start;
    if (limit > data.length) {
      throw new OneNoteFormatError(
        "ONENOTE_FSSHTTPB_RANGE",
        "A structure claims to extend past the end of the file.",
        base + start
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
    return new _Cursor(this.data, this.position, this.position + length, this.base);
  }
  ensure(length) {
    if (length < 0 || this.position + length > this.limit) {
      throw new OneNoteFormatError(
        "ONENOTE_FSSHTTPB_RANGE",
        `Reading ${length} bytes would pass the end of the structure.`,
        this.base + this.position
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
        this.base + this.position
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
          this.base + this.position - 9
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
      this.base + start
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
    const start = this.position;
    const offset = this.base + start;
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
          headerLength: this.position - start
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
  DataElementType2[DataElementType2["ObjectDataBlob"] = 10] = "ObjectDataBlob";
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
  const head2 = expect(element.children.at(0), 26 /* RevisionManifest */, "a revision manifest");
  const { revision, baseRevision } = readExact(data, head2, (cursor) => ({
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
      case 10 /* ObjectDataBlob */: {
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
        record.fileDataReference = fileDataReferenceOf(record);
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
function fileDataReferenceOf(record) {
  const raw = readData(record, Property.fileDataReference);
  if (raw?.length === 16) {
    const hex = [...raw].map((byte) => byte.toString(16).padStart(2, "0"));
    const at = (...order) => order.map((index) => hex[index]).join("");
    return `<ifndf>{${at(3, 2, 1, 0)}-${at(5, 4)}-${at(7, 6)}-${at(8, 9)}-${at(10, 11, 12, 13, 14, 15)}}`;
  }
  return readString(record, Property.fileDataReference);
}
function fileDataId(reference) {
  if (!reference || !reference.toLowerCase().startsWith("<ifndf>")) return void 0;
  return reference.slice(7).trim().replace(/\0+$/, "").replace(/^\{|\}$/g, "").toLowerCase();
}
function assignCell(head2, cell, byRevisionId, order) {
  const visited = /* @__PURE__ */ new Set();
  let revision = head2;
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
function readSections(data, fallbackName, {
  wanted,
  limits = DEFAULT_CABINET_LIMITS,
  options = DEFAULT_READER_OPTIONS
} = {}) {
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
  return readCabinetIndex(data, limits).entries.filter((entry) => isSection(entry.name)).map((entry) => ({
    name: entry.name,
    title: titleOf(entry.name),
    groups: groupsOf(entry.name),
    folderIndex: entry.folderIndex,
    expandedLength: entry.length
  }));
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
function inspect(data, fileName, limits) {
  return listSections(data, fileName, limits);
}
async function convertFile(data, fileName, sink, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const report = { input: fileName, notes: [], attachments: [], skipped: [], errors: [], cancelled: false };
  const { names, byContent } = opts.workspace ?? new Workspace();
  let entries;
  try {
    entries = readSections(data, fileName, {
      wanted: opts.sections?.size ? opts.sections : void 0,
      limits: opts.limits,
      options: opts.readerOptions
    });
  } catch (error) {
    report.errors.push(failure(fileName, error));
    return report;
  }
  const notebook = opts.notebookName ?? (entries.length > 1 || entries[0]?.groups.length ? baseName(fileName) : void 0);
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
    opts.onProgress?.({ kind: "note", name: stem, index: ++done, total: pages.length });
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
  /**
   * The folder the last write went to, and nothing else.
   *
   * `mkdirSync` with `recursive` is already idempotent, so remembering every
   * folder ever created saves a syscall and costs an entry per folder — which
   * for a notebook whose every page has subpages and attachments is an entry
   * per page. One is enough: a conversion writes a note, then its assets,
   * then the next note, so consecutive writes almost always share a folder
   * and the run of repeats is what the saving was ever coming from.
   */
  lastDir;
  /**
   * Files open right now, so a forced exit can delete them.
   *
   * A conversion holds at most two of these — the note being written and the
   * asset being written inside it — so this is a fixed-size set rather than
   * a growing one, and a writer removes itself on close either way.
   *
   * It exists because of what a second Ctrl-C does. The first asks the
   * conversion to stop, and the ordinary unwinding aborts the note in
   * progress. The second does not wait to be asked: it calls `process.exit`,
   * nothing unwinds, and whatever was open stays on disk as a file that
   * looks like a note and is half of one. Nothing else can clean those up,
   * because by then there is no stack left to do it from.
   */
  openWriters = /* @__PURE__ */ new Set();
  async write(path, data) {
    nodeFs.writeFileSync(this.prepare(path), data, { flag: this.flag });
  }
  /**
   * The bounded path: bytes go to the descriptor as they arrive.
   *
   * This is what keeps an attachment's size off the heap. The same `wx` rule
   * applies, and it applies at open — so a run that would clobber a file it
   * did not create fails before anything is written rather than partway
   * through.
   */
  async open(path) {
    const full = this.prepare(path);
    const descriptor = nodeFs.openSync(full, this.flag);
    const sink = this;
    let position = 0;
    let settled = false;
    const entry = {
      abort() {
        if (settled) return;
        settled = true;
        sink.openWriters.delete(entry);
        try {
          nodeFs.closeSync(descriptor);
        } finally {
          nodeFs.rmSync(full, { force: true });
        }
      }
    };
    this.openWriters.add(entry);
    return {
      async write(chunk) {
        let written = 0;
        while (written < chunk.byteLength) {
          written += nodeFs.writeSync(descriptor, chunk, written, chunk.byteLength - written, position + written);
        }
        position += chunk.byteLength;
      },
      async close() {
        if (settled) return;
        settled = true;
        sink.openWriters.delete(entry);
        nodeFs.closeSync(descriptor);
      },
      async abort() {
        entry.abort();
      }
    };
  }
  /**
   * Abandon and delete every file still open, without waiting to be asked.
   *
   * For the exit that does not unwind. Synchronous on purpose: an `exit`
   * handler and a second signal both run with no opportunity to await, so a
   * promise here would resolve after the process was gone.
   *
   * Idempotent, and safe to call after everything has closed normally — in
   * which case there is nothing left in the set and it does nothing.
   */
  abortAll() {
    for (const entry of [...this.openWriters]) {
      try {
        entry.abort();
      } catch {
      }
    }
    this.openWriters.clear();
  }
  /** Files this sink still has open. For the tests, and for asserting zero. */
  get openCount() {
    return this.openWriters.size;
  }
  get flag() {
    return this.overwrite ? "w" : "wx";
  }
  prepare(path) {
    const full = nodePath.join(this.root, ...path.split("/"));
    const dir = nodePath.dirname(full);
    if (dir !== this.lastDir) {
      nodeFs.mkdirSync(dir, { recursive: true });
      this.lastDir = dir;
    }
    return full;
  }
};
var NullSink = class {
  bytes = 0;
  /** Files completed. An aborted one is not one, so it is not counted. */
  files = 0;
  async write(_path, data) {
    this.bytes += data.byteLength;
    this.files++;
  }
  async open(_path) {
    const sink = this;
    return {
      async write(chunk) {
        sink.bytes += chunk.byteLength;
      },
      async close() {
        sink.files++;
      },
      async abort() {
      }
    };
  }
};

// src/storage/byte-source.ts
import * as nodeFs2 from "node:fs";
var ByteSourceError = class extends Error {
  code;
  offset;
  length;
  constructor(code, message, offset, length) {
    super(message);
    this.name = "ByteSourceError";
    this.code = code;
    this.offset = offset;
    this.length = length;
  }
};
function checkRead(size, offset, length) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length)) {
    throw new ByteSourceError(
      "BYTE_SOURCE_INVALID_RANGE",
      `ByteSource reads require safe-integer offsets and lengths; received offset ${offset}, length ${length}.`,
      offset,
      length
    );
  }
  if (offset < 0 || length < 0 || offset > size - length) {
    throw new ByteSourceError(
      "BYTE_SOURCE_OUT_OF_BOUNDS",
      `Cannot read ${length} bytes at offset ${offset} from a ${size}-byte source.`,
      offset,
      length
    );
  }
}
var FileDescriptorByteSource = class {
  size;
  #fd;
  constructor(fd, size = nodeFs2.fstatSync(fd).size) {
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new ByteSourceError(
        "BYTE_SOURCE_INVALID_SIZE",
        `File descriptor ByteSource size must be a non-negative safe integer; received ${size}.`
      );
    }
    this.#fd = fd;
    this.size = size;
  }
  read(offset, length) {
    checkRead(this.size, offset, length);
    const result = new Uint8Array(length);
    let read = 0;
    while (read < length) {
      const count = nodeFs2.readSync(this.#fd, result, read, length - read, offset + read);
      if (count === 0) {
        throw new ByteSourceError(
          "BYTE_SOURCE_SHORT_READ",
          `File descriptor ended after ${read} of ${length} requested bytes at offset ${offset}; the file may have been truncated after the source was opened.`,
          offset,
          length
        );
      }
      read += count;
    }
    return result;
  }
};

// src/storage/byte-window.ts
var DEFAULT_WINDOW_BYTES = 64 * 1024;
var ByteWindow = class {
  source;
  capacity;
  #buffer = new Uint8Array(0);
  #start = 0;
  #refills = 0;
  constructor(source, capacity = DEFAULT_WINDOW_BYTES) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
      throw new ByteSourceError(
        "BYTE_WINDOW_INVALID_CAPACITY",
        `A byte window capacity must be a positive safe integer; received ${capacity}.`
      );
    }
    this.source = source;
    this.capacity = capacity;
  }
  get size() {
    return this.source.size;
  }
  /** Bytes held resident, which never exceeds one window. */
  get residentBytes() {
    return this.#buffer.byteLength;
  }
  /** How many times the window has gone to the source. */
  get refills() {
    return this.#refills;
  }
  /** Bytes valid only until the next call on this window. */
  peek(offset, length) {
    if (length > this.capacity) {
      throw new ByteSourceError(
        "BYTE_WINDOW_TOO_LARGE",
        `A ${length}-byte peek exceeds the ${this.capacity}-byte window; read an owned copy instead.`,
        offset,
        length
      );
    }
    const from = offset - this.#start;
    if (from >= 0 && from + length <= this.#buffer.byteLength) {
      return this.#buffer.subarray(from, from + length);
    }
    return this.#refill(offset, length);
  }
  /** An owned copy, of any length the source can supply. */
  read(offset, length) {
    if (length > this.capacity) return this.source.read(offset, length);
    return this.peek(offset, length).slice();
  }
  #refill(offset, length) {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset > this.source.size - length) {
      this.source.read(offset, length);
    }
    const span = Math.min(this.capacity, this.source.size - offset);
    this.#buffer = this.source.read(offset, span);
    this.#start = offset;
    this.#refills++;
    return this.#buffer.subarray(0, length);
  }
};

// src/storage/records.ts
var GUID_TEXT_LENGTH = 36;
var encoder2 = new TextEncoder();
var decoder = new TextDecoder();
var RecordError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "RecordError";
    this.code = code;
  }
};
var RecordWriter = class {
  #buffer;
  #view;
  #length = 0;
  constructor(capacity = 128) {
    this.#buffer = new Uint8Array(Math.max(capacity, 8));
    this.#view = new DataView(this.#buffer.buffer);
  }
  get length() {
    return this.#length;
  }
  /** Starts a new record, optionally opening it with a namespace tag. */
  reset(tag) {
    this.#length = 0;
    return tag === void 0 ? this : this.u8(tag);
  }
  done() {
    return this.#buffer.subarray(0, this.#length);
  }
  // Every one of these takes the offset into a local first. `#room` may grow
  // the record, which replaces both the buffer and the view over it, and an
  // argument is evaluated only after the callee has been resolved — so
  // passing `#room(...)` straight to `this.#view` writes into the old view.
  u8(value) {
    const at = this.#room(1);
    this.#view.setUint8(at, value & 255);
    return this;
  }
  u16(value) {
    const at = this.#room(2);
    this.#view.setUint16(at, value & 65535, true);
    return this;
  }
  u32(value) {
    const at = this.#room(4);
    this.#view.setUint32(at, value >>> 0, true);
    return this;
  }
  i32(value) {
    const at = this.#room(4);
    this.#view.setInt32(at, value | 0, true);
    return this;
  }
  flag(value) {
    return this.u8(value ? 1 : 0);
  }
  /** A file offset or byte count, exact across the whole safe-integer range. */
  big(value) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RecordError(
        "RECORD_VALUE_RANGE",
        `A record offset or count must be a non-negative safe integer; received ${value}.`
      );
    }
    const at = this.#room(8);
    this.#view.setUint32(at, value % 4294967296, true);
    this.#view.setUint32(at + 4, Math.floor(value / 4294967296), true);
    return this;
  }
  optionalBig(value) {
    return value === void 0 ? this.flag(false) : this.flag(true).big(value);
  }
  /**
   * A number stored without loss.
   *
   * Coordinates and widths reach the output as `${value}`, so anything that
   * rounds them changes what is written. This is the one field type that
   * exists to preserve a value exactly rather than compactly.
   */
  f64(value) {
    const at = this.#room(8);
    this.#view.setFloat64(at, value, true);
    return this;
  }
  range(value) {
    return this.big(value.offset).big(value.length);
  }
  optionalRange(value) {
    return value === void 0 ? this.flag(false) : this.flag(true).range(value);
  }
  guid(value) {
    if (value.length !== GUID_TEXT_LENGTH) {
      throw new RecordError(
        "RECORD_GUID_LENGTH",
        `A record GUID must be ${GUID_TEXT_LENGTH} characters; received ${JSON.stringify(value)}.`
      );
    }
    const at = this.#room(GUID_TEXT_LENGTH);
    for (let index = 0; index < GUID_TEXT_LENGTH; index++) {
      this.#buffer[at + index] = value.charCodeAt(index);
    }
    return this;
  }
  extendedGuid(value) {
    return this.guid(value.identifier).u32(value.value);
  }
  optionalExtendedGuid(value) {
    return value === void 0 ? this.flag(false) : this.flag(true).extendedGuid(value);
  }
  text(value) {
    const bytes = encoder2.encode(value);
    this.u32(bytes.byteLength);
    return this.bytes(bytes);
  }
  optionalText(value) {
    return value === void 0 ? this.flag(false) : this.flag(true).text(value);
  }
  bytes(value) {
    const at = this.#room(value.byteLength);
    this.#buffer.set(value, at);
    return this;
  }
  #room(bytes) {
    const at = this.#length;
    const needed = at + bytes;
    if (needed > this.#buffer.byteLength) {
      let capacity = this.#buffer.byteLength;
      while (capacity < needed) capacity *= 2;
      const grown = new Uint8Array(capacity);
      grown.set(this.#buffer.subarray(0, at));
      this.#buffer = grown;
      this.#view = new DataView(grown.buffer);
    }
    this.#length = needed;
    return at;
  }
};
var RecordReader = class {
  data;
  #view;
  #position;
  constructor(data, start = 0) {
    this.data = data;
    this.#view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    this.#position = start;
  }
  get position() {
    return this.#position;
  }
  get atEnd() {
    return this.#position >= this.data.byteLength;
  }
  u8() {
    return this.#view.getUint8(this.#take(1));
  }
  u16() {
    return this.#view.getUint16(this.#take(2), true);
  }
  u32() {
    return this.#view.getUint32(this.#take(4), true);
  }
  i32() {
    return this.#view.getInt32(this.#take(4), true);
  }
  flag() {
    return this.u8() !== 0;
  }
  f64() {
    return this.#view.getFloat64(this.#take(8), true);
  }
  big() {
    const at = this.#take(8);
    const value = this.#view.getUint32(at + 4, true) * 4294967296 + this.#view.getUint32(at, true);
    if (!Number.isSafeInteger(value)) {
      throw new RecordError("RECORD_CORRUPT", "A stored offset or count is outside the safe-integer range.");
    }
    return value;
  }
  optionalBig() {
    return this.flag() ? this.big() : void 0;
  }
  range() {
    return { offset: this.big(), length: this.big() };
  }
  optionalRange() {
    return this.flag() ? this.range() : void 0;
  }
  guid() {
    const at = this.#take(GUID_TEXT_LENGTH);
    return decoder.decode(this.data.subarray(at, at + GUID_TEXT_LENGTH));
  }
  extendedGuid() {
    return { identifier: this.guid(), value: this.u32() };
  }
  optionalExtendedGuid() {
    return this.flag() ? this.extendedGuid() : void 0;
  }
  text() {
    const length = this.u32();
    const at = this.#take(length);
    return decoder.decode(this.data.subarray(at, at + length));
  }
  optionalText() {
    return this.flag() ? this.text() : void 0;
  }
  #take(bytes) {
    const at = this.#position;
    if (bytes < 0 || at + bytes > this.data.byteLength) {
      throw new RecordError(
        "RECORD_TRUNCATED",
        `A stored record ended after ${this.data.byteLength} bytes while reading ${bytes} more at ${at}.`
      );
    }
    this.#position = at + bytes;
    return at;
  }
};

// src/storage/spool.ts
var SpoolError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "SpoolError";
    this.code = code;
  }
};
var DEFAULT_CHUNK_BYTES = 4096;
var encoder3 = new TextEncoder();
var decoder2 = new TextDecoder();
var ByteSpool = class {
  chunkBytes;
  #store;
  #tag;
  #id;
  #key = new RecordWriter(16);
  #pending;
  #pendingLength = 0;
  #chunks = 0;
  #length = 0;
  constructor(store, tag, id, chunkBytes = DEFAULT_CHUNK_BYTES) {
    this.#store = store;
    this.#tag = tag;
    this.#id = id;
    this.chunkBytes = chunkBytes;
    this.#pending = new Uint8Array(chunkBytes);
  }
  /** Bytes appended so far. */
  get length() {
    return this.#length;
  }
  get isEmpty() {
    return this.#length === 0;
  }
  /** Bytes held in memory rather than in the store. */
  get residentBytes() {
    return this.#pending.byteLength;
  }
  write(bytes) {
    let written = 0;
    while (written < bytes.byteLength) {
      const room = this.chunkBytes - this.#pendingLength;
      const take = Math.min(room, bytes.byteLength - written);
      this.#pending.set(bytes.subarray(written, written + take), this.#pendingLength);
      this.#pendingLength += take;
      this.#length += take;
      written += take;
      if (this.#pendingLength === this.chunkBytes) this.#flush();
    }
  }
  /**
   * Append text as UTF-8.
   *
   * The encoded bytes of the argument are transient, so this is bounded by the
   * caller's string rather than by the spool: append in pieces to keep it so.
   */
  writeText(text) {
    if (text !== "") this.write(encoder3.encode(text));
  }
  /** The bytes, in the order they were written. */
  *chunks() {
    for (let index = 0; index < this.#chunks; index++) {
      const stored = this.#store.get(this.#chunkKey(index));
      if (!stored) {
        throw new SpoolError(
          "SPOOL_MISSING_CHUNK",
          `Chunk ${index} of ${this.#chunks} is not in the store; the spool was reset or its store was reused.`
        );
      }
      yield stored;
    }
    if (this.#pendingLength > 0) yield this.#pending.subarray(0, this.#pendingLength);
  }
  /**
   * The bytes as text, decoded across chunk boundaries.
   *
   * A chunk can end in the middle of a UTF-8 sequence, so this is the only
   * safe way to read text back: decoding each chunk on its own would corrupt
   * whatever character the boundary fell inside.
   */
  *text() {
    const streaming = new TextDecoder();
    for (const chunk of this.chunks()) {
      const piece = streaming.decode(chunk, { stream: true });
      if (piece !== "") yield piece;
    }
    const tail = streaming.decode();
    if (tail !== "") yield tail;
  }
  /** The whole spool as one string. Only for a spool known to be small. */
  readAllText() {
    if (this.#chunks === 0) return decoder2.decode(this.#pending.subarray(0, this.#pendingLength));
    let value = "";
    for (const piece of this.text()) value += piece;
    return value;
  }
  /** Forget everything written, so the region can be used again. */
  reset() {
    this.#pendingLength = 0;
    this.#chunks = 0;
    this.#length = 0;
  }
  #flush() {
    this.#store.set(this.#chunkKey(this.#chunks), this.#pending.subarray(0, this.#pendingLength));
    this.#chunks++;
    this.#pendingLength = 0;
  }
  #chunkKey(index) {
    return this.#key.reset(this.#tag).u32(this.#id).u32(index).done();
  }
};
var RecordSpool = class {
  #store;
  #tag;
  #id;
  #key = new RecordWriter(16);
  #count = 0;
  constructor(store, tag, id) {
    this.#store = store;
    this.#tag = tag;
    this.#id = id;
  }
  get count() {
    return this.#count;
  }
  get isEmpty() {
    return this.#count === 0;
  }
  /** Appends a record and answers with its position. */
  push(value) {
    const position = this.#count++;
    this.#store.set(this.#entryKey(position), value);
    return position;
  }
  at(position) {
    const stored = this.#store.get(this.#entryKey(position));
    if (!stored) {
      throw new SpoolError(
        "SPOOL_MISSING_RECORD",
        `Record ${position} of ${this.#count} is not in the store; the spool was reset or its store was reused.`
      );
    }
    return stored;
  }
  *values() {
    for (let position = 0; position < this.#count; position++) yield this.at(position);
  }
  reset() {
    this.#count = 0;
  }
  #entryKey(position) {
    return this.#key.reset(this.#tag).u32(this.#id).u32(position).done();
  }
};

// src/stream/limits.ts
var ValueMeter = class {
  #value = 0;
  #math = 0;
  /** Characters of a metadata value about to be, or just, materialized. */
  value(chars) {
    if (chars > this.#value) this.#value = chars;
  }
  math(chars) {
    if (chars > this.#math) this.#math = chars;
  }
  get peakValueChars() {
    return this.#value;
  }
  get peakMathChars() {
    return this.#math;
  }
  /**
   * Bytes the reserve must hold for what was actually seen.
   *
   * The same arithmetic `planBudget` reserves by, applied to observation
   * instead of to a ceiling — so the two can be compared.
   */
  get reservedBytesUsed() {
    return reserveFor(this.#value, this.#math);
  }
};
var VALUE_COPIES = 5;
var MATH_COPIES = 8;
function reserveFor(valueChars, mathChars) {
  return 2 * (VALUE_COPIES * valueChars + MATH_COPIES * mathChars);
}
var DEFAULT_STREAM_LIMITS = {
  maxValueChars: 1 << 20,
  maxMathChars: 1 << 20,
  runWhitespaceChars: 64 * 1024,
  maxTableColumns: 4096
};
var VALUE_SHARE = 0.75;
var DEFAULT_VALUE_RESERVE_BYTES = 1024 * 1024;
function limitsFor(reserveBytes, overrides = {}) {
  const valueChars = Math.floor(reserveBytes * VALUE_SHARE / (2 * VALUE_COPIES));
  const mathChars = Math.floor(reserveBytes * (1 - VALUE_SHARE) / (2 * MATH_COPIES));
  return {
    ...DEFAULT_STREAM_LIMITS,
    maxValueChars: Math.max(1, valueChars),
    maxMathChars: Math.max(1, mathChars),
    ...overrides
  };
}
function overValueLimit(what, found, limit, option) {
  return new OneNoteFormatError(
    "ONENOTE_VALUE_LIMIT",
    `${what} is ${found} characters, over the ${limit}-character limit. Raise \`${option}\` to convert it, or convert with a larger memory budget.`
  );
}
function joinBounded(current, part, limit, what, meter) {
  if (current === "") {
    if (part.length > limit) throw overValueLimit(what, part.length, limit, "maxValueChars");
    meter?.value(part.length);
    return part;
  }
  const total = current.length + 1 + part.length;
  if (total > limit) throw overValueLimit(what, total, limit, "maxValueChars");
  meter?.value(total);
  return `${current} ${part}`;
}
var ConversionCancelled = class extends Error {
  code = "ONE2MD_CANCELLED";
  constructor() {
    super("The conversion was cancelled.");
    this.name = "ConversionCancelled";
  }
};
function isCancellation(error) {
  return error instanceof ConversionCancelled || error?.code === "ONE2MD_CANCELLED";
}
function overCountLimit(what, found, limit, option) {
  return new OneNoteFormatError(
    "ONENOTE_STRUCTURE_LIMIT",
    `${what} is ${found}, over the limit of ${limit}. Raise \`${option}\` to convert it.`
  );
}

// src/stream/text.ts
var DEFAULT_SPILL_BUDGET = 64 * 1024;
var WHITESPACE = /* @__PURE__ */ new Set([
  9,
  10,
  11,
  12,
  13,
  32,
  160,
  5760,
  8192,
  8193,
  8194,
  8195,
  8196,
  8197,
  8198,
  8199,
  8200,
  8201,
  8202,
  8232,
  8233,
  8239,
  8287,
  12288,
  65279
]);
function isWhitespace(code) {
  return WHITESPACE.has(code);
}
var TextSpill = class {
  budget;
  #spool;
  #head = "";
  #spilled = false;
  #length = 0;
  constructor(spool, budget = DEFAULT_SPILL_BUDGET) {
    this.#spool = spool;
    this.budget = budget;
  }
  /** Length in UTF-16 code units, as `String.length` counts. */
  get length() {
    return this.#length;
  }
  get isEmpty() {
    return this.#length === 0;
  }
  /** Whether the text outgrew its budget and went to disk. */
  get spilled() {
    return this.#spilled;
  }
  append(text) {
    if (text === "") return;
    this.#length += text.length;
    if (!this.#spilled && this.#head.length + text.length <= this.budget) {
      this.#head += text;
      return;
    }
    if (!this.#spilled) {
      this.#spool.reset();
      this.#spool.writeText(this.#head);
      this.#head = "";
      this.#spilled = true;
    }
    this.#spool.writeText(text);
  }
  /** The text in pieces, in order. Re-readable as often as needed. */
  *pieces() {
    if (this.#spilled) yield* this.#spool.text();
    else if (this.#head !== "") yield this.#head;
  }
  clear() {
    this.#head = "";
    this.#length = 0;
    if (this.#spilled) this.#spool.reset();
    this.#spilled = false;
  }
};
var CarriageReturnFilter = class {
  constructor(emit) {
    this.emit = emit;
  }
  #pendingReturn = false;
  async push(piece) {
    let out = "";
    for (let index = 0; index < piece.length; index++) {
      const character = piece[index];
      if (this.#pendingReturn) {
        this.#pendingReturn = false;
        if (character === "\n") continue;
      }
      if (character === "\r") {
        this.#pendingReturn = true;
        out += "\n";
        continue;
      }
      out += character;
    }
    if (out !== "") await this.emit(out);
  }
  async finish() {
    this.#pendingReturn = false;
  }
};
var Trimmer = class {
  constructor(emit, pending) {
    this.emit = emit;
    this.pending = pending;
  }
  #seenContent = false;
  async push(piece) {
    let start = 0;
    if (!this.#seenContent) {
      while (start < piece.length && isWhitespace(piece.charCodeAt(start))) start++;
      if (start === piece.length) return;
      this.#seenContent = true;
    }
    let end = piece.length;
    while (end > start && isWhitespace(piece.charCodeAt(end - 1))) end--;
    if (end > start) {
      for (const held of this.pending.pieces()) await this.emit(held);
      this.pending.clear();
      await this.emit(piece.slice(start, end));
    }
    if (end < piece.length) this.pending.append(piece.slice(end));
  }
  async finish() {
    this.pending.clear();
  }
};
var NewlineCollapser = class {
  constructor(emit) {
    this.emit = emit;
  }
  #run = 0;
  async push(piece) {
    let out = "";
    for (let index = 0; index < piece.length; index++) {
      if (piece[index] === "\n") {
        this.#run++;
        continue;
      }
      out += this.#collapsed();
      out += piece[index];
    }
    if (out !== "") await this.emit(out);
  }
  async finish() {
    const tail = this.#collapsed();
    if (tail !== "") await this.emit(tail);
  }
  #collapsed() {
    const run = this.#run;
    this.#run = 0;
    return run === 0 ? "" : "\n".repeat(run < 3 ? run : 2);
  }
};
function decideLineStart(pieces) {
  let whitespaceLength = 0;
  let leading = true;
  let head2 = "";
  let headRun = 0;
  let after = "";
  let digits = 0;
  for (const piece of pieces) {
    for (let index = 0; index < piece.length; index++) {
      const character = piece[index];
      if (leading) {
        if (isWhitespace(piece.charCodeAt(index))) {
          whitespaceLength++;
          continue;
        }
        leading = false;
        head2 = character;
        headRun = 1;
        if (character >= "0" && character <= "9") digits = 1;
        continue;
      }
      if (after === "" && character === head2 && !(head2 >= "0" && head2 <= "9")) {
        headRun++;
        continue;
      }
      if (after === "" && digits > 0 && character >= "0" && character <= "9") {
        digits++;
        continue;
      }
      if (after.length < 3) after += character;
    }
  }
  return { matched: matches(head2, headRun, digits, after), whitespaceLength };
}
function matches(head2, headRun, digits, after) {
  if (head2 === "") return false;
  const nextIsBreak = after === "" || isWhitespace(after.charCodeAt(0));
  if (head2 === "#") return headRun <= 6 && nextIsBreak;
  if (head2 === ">" || head2 === "|") return true;
  if (head2 === "`" || head2 === "~") return headRun >= 3;
  if (head2 === "-" || head2 === "*" || head2 === "+") {
    if (headRun === 1 && nextIsBreak && after !== "") return true;
    if (headRun === 1 && after === "") return false;
    return head2 === "-" && headRun >= 3 && after === "";
  }
  if (head2 === "=") return headRun >= 3 && after === "";
  if (digits > 0) return (after[0] === "." || after[0] === ")") && after.length > 1 && isWhitespace(after.charCodeAt(1));
  return false;
}

// src/stream/budget.ts
var PAGE_BYTES = 64 * 1024;
var MINIMUM_WINDOW_BYTES = DEFAULT_WINDOW_BYTES;
var SPILL_REGIONS = 4;
var SPOOL_BUFFERS = 10;
var DEFAULT_NOTE_BUFFER_BYTES = 8192;
var FIXED_BUFFER_SHARE = 0.25;
var LARGE_COMPONENTS = 4;
var RECORD_COPY_PAGES = 3;
var VALUE_RESERVE_SHARE = 0.125;
var MINIMUM_VALUE_RESERVE_BYTES = 96 * 1024;
var MINIMUM_SPILL_CHARS = 4096;
var MINIMUM_CHUNK_BYTES = 512;
var MINIMUM_NOTE_BUFFER_BYTES = 1024;
var MINIMUM_BUDGET_BYTES = 1024 * 1024;
var DEFAULT_BOUNDED_BUDGET_BYTES = 32 * 1024 * 1024;
var BudgetError = class extends Error {
  code = "ONE2MD_BUDGET_TOO_SMALL";
  constructor(message) {
    super(message);
    this.name = "BudgetError";
  }
};
function planBudget(totalBytes, tempDirectory) {
  if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) {
    throw new BudgetError(
      `A memory budget must be a positive byte count, not ${totalBytes}.`
    );
  }
  if (totalBytes < MINIMUM_BUDGET_BYTES) {
    throw new BudgetError(
      `A memory budget of ${format(totalBytes)} is below the ${format(MINIMUM_BUDGET_BYTES)} minimum. Below that there is not enough for a ${format(MINIMUM_WINDOW_BYTES)} read window, three ${format(PAGE_BYTES)} store pages, the write buffers, the ${format(RECORD_COPY_PAGES * PAGE_BYTES)} of record copies and the ${format(MINIMUM_VALUE_RESERVE_BYTES)} held for page titles and maths runs. Use --memory-budget ${format(MINIMUM_BUDGET_BYTES)} or more.`
    );
  }
  const wanted = SPILL_REGIONS * DEFAULT_SPILL_BUDGET * 2 + SPOOL_BUFFERS * DEFAULT_CHUNK_BYTES + DEFAULT_NOTE_BUFFER_BYTES;
  const allowed = Math.floor(totalBytes * FIXED_BUFFER_SHARE);
  const scale = Math.min(1, allowed / wanted);
  const spillChars = Math.max(MINIMUM_SPILL_CHARS, floorTo(DEFAULT_SPILL_BUDGET * scale, 1024));
  const chunkBytes = Math.max(MINIMUM_CHUNK_BYTES, floorTo(DEFAULT_CHUNK_BYTES * scale, 256));
  const noteBufferBytes = Math.max(
    MINIMUM_NOTE_BUFFER_BYTES,
    floorTo(DEFAULT_NOTE_BUFFER_BYTES * scale, 512)
  );
  const recordCopyBytes = RECORD_COPY_PAGES * PAGE_BYTES;
  const fixedBytes = SPILL_REGIONS * spillChars * 2 + SPOOL_BUFFERS * chunkBytes + noteBufferBytes + recordCopyBytes;
  const valueReserveBytes = Math.max(
    MINIMUM_VALUE_RESERVE_BYTES,
    Math.floor(totalBytes * VALUE_RESERVE_SHARE)
  );
  const limits = limitsFor(valueReserveBytes);
  const large = totalBytes - fixedBytes - valueReserveBytes;
  const cacheBytes = floorTo(Math.floor(large / LARGE_COMPONENTS), PAGE_BYTES);
  const windowBytes = floorTo(large - cacheBytes * 3, 4096);
  if (cacheBytes < PAGE_BYTES || windowBytes < MINIMUM_WINDOW_BYTES) {
    throw new BudgetError(
      `A memory budget of ${format(totalBytes)} leaves ${format(Math.floor(large / LARGE_COMPONENTS))} per component, which is under the ${format(Math.max(PAGE_BYTES, MINIMUM_WINDOW_BYTES))} each one needs. Use --memory-budget ${format(MINIMUM_BUDGET_BYTES)} or more.`
    );
  }
  return {
    totalBytes,
    tempDirectory,
    workspaceCacheBytes: cacheBytes,
    indexCacheBytes: cacheBytes,
    conversionCacheBytes: cacheBytes,
    windowBytes,
    noteBufferBytes,
    spillChars,
    chunkBytes,
    pageSize: PAGE_BYTES,
    valueReserveBytes,
    recordCopyBytes,
    limits,
    accountedBytes: cacheBytes * 3 + windowBytes + fixedBytes + valueReserveBytes
  };
}
function floorTo(value, unit) {
  return Math.floor(value / unit) * unit;
}
function sectionStorageFor(budget) {
  return {
    pageSize: budget.pageSize,
    cacheBytes: budget.indexCacheBytes,
    conversionCacheBytes: budget.conversionCacheBytes,
    windowBytes: budget.windowBytes,
    spillChars: budget.spillChars,
    chunkBytes: budget.chunkBytes,
    noteBufferBytes: budget.noteBufferBytes,
    // Passed rather than recomputed, so the ceilings a section enforces are
    // the ones this budget reserved for and not a second derivation of them.
    limits: budget.limits,
    valueReserveBytes: budget.valueReserveBytes,
    tempDirectory: budget.tempDirectory
  };
}
function workspaceStorageFor(budget) {
  return {
    pageSize: budget.pageSize,
    cacheBytes: budget.workspaceCacheBytes,
    tempDirectory: budget.tempDirectory
  };
}
function summarize(budget) {
  return `memory budget ${format(budget.totalBytes)}: caches ${format(budget.workspaceCacheBytes)} x3, window ${format(budget.windowBytes)}, values ${format(budget.valueReserveBytes)}, buffers ${format(budget.accountedBytes - budget.workspaceCacheBytes * 3 - budget.windowBytes - budget.valueReserveBytes)}`;
}
function fixedBufferBytes(budget) {
  return SPILL_REGIONS * budget.spillChars * 2 + SPOOL_BUFFERS * budget.chunkBytes + budget.noteBufferBytes + budget.recordCopyBytes;
}
function format(bytes) {
  if (bytes >= 1024 * 1024 && bytes % (1024 * 1024) === 0) return `${bytes / (1024 * 1024)}M`;
  if (bytes >= 1024 && bytes % 1024 === 0) return `${bytes / 1024}K`;
  return `${bytes}`;
}

// src/stream/report-json.ts
var INDENT = "  ";
var BufferedTextOut = class {
  #target;
  #capacity;
  #pending = "";
  constructor(target, capacity = 8192) {
    this.#target = target;
    this.#capacity = capacity;
  }
  write(text) {
    this.#pending += text;
    if (this.#pending.length >= this.#capacity) this.flush();
  }
  flush() {
    if (this.#pending === "") return;
    const pending = this.#pending;
    this.#pending = "";
    this.#target(pending);
  }
};
function writeJsonReport(out, workspace, groups, meta) {
  out.write("{\n");
  out.write(`${INDENT}"ok": ${meta.ok},
`);
  out.write(`${INDENT}"out": ${JSON.stringify(meta.out)},
`);
  out.write(`${INDENT}"dryRun": ${meta.dryRun},
`);
  const walk2 = groups[Symbol.iterator]();
  let next = walk2.next();
  if (next.done) {
    out.write(`${INDENT}"reports": []
`);
    out.write("}\n");
    return;
  }
  out.write(`${INDENT}"reports": [
`);
  while (!next.done) {
    const group = next.value;
    next = walk2.next();
    writeGroup(out, workspace, group, 2);
    out.write(next.done ? "\n" : ",\n");
  }
  out.write(`${INDENT}]
`);
  out.write("}\n");
}
function writeGroup(out, workspace, group, depth) {
  const pad = INDENT.repeat(depth);
  const inner = INDENT.repeat(depth + 1);
  out.write(`${pad}{
`);
  out.write(`${inner}"input": ${JSON.stringify(group.input)},
`);
  writeArray(
    out,
    "notes",
    depth + 1,
    group.to.notes - group.from.notes,
    workspace.notes(group.from.notes, group.to.notes)
  );
  out.write(",\n");
  writeArray(
    out,
    "attachments",
    depth + 1,
    group.to.attachments - group.from.attachments,
    workspace.attachments(group.from.attachments, group.to.attachments)
  );
  out.write(",\n");
  writeArray(
    out,
    "skipped",
    depth + 1,
    group.to.skipped - group.from.skipped,
    workspace.skips(group.from.skipped, group.to.skipped)
  );
  out.write(",\n");
  writeArray(
    out,
    "errors",
    depth + 1,
    group.to.errors - group.from.errors,
    workspace.failures(group.from.errors, group.to.errors)
  );
  out.write(",\n");
  out.write(`${inner}"cancelled": ${group.cancelled}
`);
  out.write(`${pad}}`);
}
function writeArray(out, name, depth, count, items) {
  const pad = INDENT.repeat(depth);
  if (count === 0) {
    out.write(`${pad}"${name}": []`);
    return;
  }
  out.write(`${pad}"${name}": [
`);
  let written = 0;
  for (const item of items) {
    out.write(indented(item, depth + 1));
    out.write(++written === count ? "\n" : ",\n");
  }
  out.write(`${pad}]`);
}
function indented(item, depth) {
  const pad = INDENT.repeat(depth);
  const text = JSON.stringify(item, null, 2);
  return pad + text.split("\n").join(`
${pad}`);
}

// src/stream/run.ts
import * as nodeFs4 from "node:fs";
import * as nodePath3 from "node:path";

// src/stream/assets.ts
import { createHash as createHash2 } from "node:crypto";

// src/resolve/range-reader.ts
var DEFAULT_STEP_BYTES = 8192;
var RangeReader = class {
  window;
  range;
  constructor(window, range) {
    this.window = window;
    this.range = range;
  }
  get length() {
    return this.range.length;
  }
  u8(offset) {
    return this.window.peek(this.range.offset + offset, 1)[0];
  }
  u16(offset) {
    const bytes = this.window.peek(this.range.offset + offset, 2);
    return bytes[0] | bytes[1] << 8;
  }
  u32(offset) {
    const bytes = this.window.peek(this.range.offset + offset, 4);
    return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
  }
  /** An owned copy. Only for a span the caller has already bounded. */
  slice(offset, length) {
    return this.window.read(this.range.offset + offset, length);
  }
  /**
   * A view into the window, valid only until the next window operation.
   *
   * For a caller that copies straight into a buffer of its own. Anything
   * that wants to hold the bytes wants `slice`.
   */
  peek(offset, length) {
    return this.window.peek(this.range.offset + offset, length);
  }
  /**
   * The range in pieces, each valid only until the next step.
   *
   * A consumer must finish with a chunk before asking for the next one: they
   * are views into the one window buffer, not copies.
   */
  *steps(offset = 0, length = this.range.length - offset, step = DEFAULT_STEP_BYTES) {
    const limit = Math.min(step, this.window.capacity);
    let position = 0;
    while (position < length) {
      const take = Math.min(limit, length - position);
      yield this.window.peek(this.range.offset + offset + position, take);
      position += take;
    }
  }
};
function utf16Length(window, range) {
  const units = range.length >>> 1;
  let end = units;
  while (end > 0) {
    const from = Math.max(0, end - (window.capacity >>> 1));
    const chunk = window.peek(range.offset + from * 2, (end - from) * 2);
    let index = end - from;
    while (index > 0 && chunk[(index - 1) * 2] === 0 && chunk[(index - 1) * 2 + 1] === 0) index--;
    end = from + index;
    if (index > 0 || from === 0) break;
  }
  return end;
}
function* utf16Text(window, range, startUnit, endUnit, step = DEFAULT_STEP_BYTES) {
  if (endUnit <= startUnit) return;
  const decoder3 = new TextDecoder("utf-16le");
  const limit = Math.max(2, (Math.min(step, window.capacity) >>> 1) * 2);
  let unit = startUnit;
  while (unit < endUnit) {
    const take = Math.min(limit >>> 1, endUnit - unit);
    const piece = decoder3.decode(window.peek(range.offset + unit * 2, take * 2), { stream: true });
    if (piece !== "") yield piece;
    unit += take;
  }
  const tail = decoder3.decode();
  if (tail !== "") yield tail;
}
function asciiLength(window, range) {
  let end = range.length;
  while (end > 0) {
    const from = Math.max(0, end - window.capacity);
    const chunk = window.peek(range.offset + from, end - from);
    let index = end - from;
    while (index > 0 && chunk[index - 1] === 0) index--;
    end = from + index;
    if (index > 0 || from === 0) break;
  }
  return end;
}
function* asciiText(window, range, start, end, step = DEFAULT_STEP_BYTES) {
  if (end <= start) return;
  const limit = Math.min(step, window.capacity);
  let position = start;
  while (position < end) {
    const take = Math.min(limit, end - position);
    const chunk = window.peek(range.offset + position, take);
    let piece = "";
    for (let index = 0; index < take; index++) piece += String.fromCharCode(chunk[index]);
    yield piece;
    position += take;
  }
}

// src/stream/assets.ts
function rangeStream(window, range) {
  return {
    length: range.length,
    *chunks() {
      yield* new RangeReader(window, range).steps();
    }
  };
}
function spoolStream(spool) {
  return {
    get length() {
      return spool.length;
    },
    chunks: () => spool.chunks()
  };
}
var SNIFF_BYTES = 12;
function head(stream, count) {
  const bytes = new Uint8Array(Math.min(count, stream.length));
  let at = 0;
  for (const chunk of stream.chunks()) {
    if (at >= bytes.byteLength) break;
    const take = Math.min(chunk.byteLength, bytes.byteLength - at);
    bytes.set(chunk.subarray(0, take), at);
    at += take;
  }
  return bytes;
}
var AssetWriter = class {
  constructor(sink, workspace, options) {
    this.sink = sink;
    this.workspace = workspace;
    this.options = options;
  }
  /**
   * Write one attachment, or answer with the one already written for it.
   *
   * Identical bytes appear repeatedly across a notebook — the same logo on
   * every page — and one copy is enough, so the digest decides before a name
   * is claimed. The digest is taken by reading the stream through once; the
   * copy reads it again. Neither holds it.
   */
  async save(stream, suggested, attachmentsDir, linkPrefix) {
    if (!this.options.writeAttachments) return null;
    let name = suggested;
    if (!extensionFromName(name)) {
      const sniffed = extensionFromBytes(head(stream, SNIFF_BYTES));
      if (sniffed) name = `${name}.${sniffed}`;
    }
    const hash = createHash2("sha256");
    for (const chunk of stream.chunks()) hash.update(chunk);
    const digest = hash.digest("hex");
    const existing = this.workspace.writtenFor(attachmentsDir, digest);
    if (existing) return existing;
    const fileName = this.workspace.claim(attachmentsDir, sanitizeFileName(name));
    const path = join3(attachmentsDir, fileName);
    const writer = await this.sink.open(path);
    try {
      for (const chunk of stream.chunks()) await writer.write(chunk);
      await writer.close();
    } catch (error) {
      await writer.abort?.();
      throw error;
    }
    this.workspace.recordAttachment(path);
    const resolved = { path: join3(linkPrefix, fileName), name: fileName };
    this.workspace.rememberContent(attachmentsDir, digest, resolved);
    return resolved;
  }
};
function join3(...parts) {
  return parts.filter((part) => part !== void 0 && part !== "").join("/");
}

// src/fsshttpb/source-cursor.ts
var WIDTH = {
  compactUint: 9,
  extendedGuid: 21,
  cellId: 42,
  guid: 16,
  serial: 25,
  streamObjectHeader: 13,
  fixed: 4
};
var SourceCursor = class _SourceCursor {
  position;
  #window;
  #limit;
  constructor(window, start = 0, limit = window.size) {
    if (limit > window.size) {
      throw new OneNoteFormatError(
        "ONENOTE_FSSHTTPB_RANGE",
        "A structure claims to extend past the end of the file.",
        start
      );
    }
    this.#window = window;
    this.#limit = limit;
    this.position = start;
  }
  get limit() {
    return this.#limit;
  }
  get remaining() {
    return this.#limit - this.position;
  }
  get atEnd() {
    return this.position >= this.#limit;
  }
  /** A cursor confined to `length` bytes starting here. */
  sub(length) {
    this.#ensure(length);
    return new _SourceCursor(this.#window, this.position, this.position + length);
  }
  skip(length) {
    this.#ensure(length);
    this.position += length;
  }
  readUInt8() {
    return this.#run(WIDTH.fixed, (cursor) => cursor.readUInt8());
  }
  readUInt16() {
    return this.#run(WIDTH.fixed, (cursor) => cursor.readUInt16());
  }
  readUInt32() {
    return this.#run(WIDTH.fixed, (cursor) => cursor.readUInt32());
  }
  readGuid() {
    return this.#run(WIDTH.guid, (cursor) => cursor.readGuid());
  }
  readCompactUint() {
    return this.#run(WIDTH.compactUint, (cursor) => cursor.readCompactUint());
  }
  readExtendedGuid() {
    return this.#run(WIDTH.extendedGuid, (cursor) => cursor.readExtendedGuid());
  }
  readCellId() {
    return this.#run(WIDTH.cellId, (cursor) => cursor.readCellId());
  }
  /** The header's `offset` is already absolute, since the frame starts here. */
  readStreamObjectHeader() {
    return this.#run(WIDTH.streamObjectHeader, (cursor) => cursor.readStreamObjectHeader());
  }
  /** [MS-FSSHTTPB] 2.2.1.9 — a serial number: a GUID and a 64-bit ordinal. */
  readSerialNumber() {
    return this.#run(WIDTH.serial, (cursor) => {
      const marker = cursor.readUInt8();
      if (marker === 0) return { identifier: "00000000-0000-0000-0000-000000000000", value: 0 };
      if (marker !== 128) {
        throw new OneNoteFormatError(
          "ONENOTE_FSSHTTPB_SERIAL_NUMBER",
          `Byte 0x${marker.toString(16)} does not begin a serial number.`,
          cursor.base + cursor.position - 1
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
          cursor.base + cursor.position - 8
        );
      }
      return { identifier, value };
    });
  }
  /** [MS-FSSHTTPB] 2.2.1.8 — steps over a counted Extended GUID array. */
  skipExtendedGuidArray() {
    const offset = this.position;
    const count = this.readCompactUint();
    for (let index = 0; index < count; index++) this.readExtendedGuid();
    return { count, range: { offset, length: this.position - offset } };
  }
  /** [MS-FSSHTTPB] 2.2.1.11 — steps over a counted cell-identifier array. */
  skipCellIdArray() {
    const offset = this.position;
    const count = this.readCompactUint();
    for (let index = 0; index < count; index++) this.readCellId();
    return { count, range: { offset, length: this.position - offset } };
  }
  /**
   * [MS-FSSHTTPB] 2.2.1.3 — a binary item, named rather than read.
   *
   * The range covers the payload only, not the compact length in front of it,
   * so it is what `readBinaryItem` would have returned.
   */
  readBinaryItemRange() {
    const length = this.readCompactUint();
    const offset = this.position;
    this.skip(length);
    return { offset, length };
  }
  #ensure(length) {
    if (length < 0 || this.position + length > this.#limit) {
      throw new OneNoteFormatError(
        "ONENOTE_FSSHTTPB_RANGE",
        `Reading ${length} bytes would pass the end of the structure.`,
        this.position
      );
    }
  }
  #run(maxBytes, decode) {
    const start = this.position;
    const span = Math.max(Math.min(maxBytes, this.#limit - start), 0);
    const cursor = new Cursor2(this.#window.peek(start, span), 0, span, start);
    const value = decode(cursor);
    this.position = start + cursor.position;
    return value;
  }
};

// src/fsshttpb/stream-walk.ts
var MAX_DEPTH2 = 64;
function* walkStreamObjects(window, from = PACKAGING_START) {
  const cursor = new SourceCursor(window, from);
  const open = [];
  const first = cursor.readStreamObjectHeader();
  if (first.kind !== "start") {
    throw new OneNoteFormatError(
      "ONENOTE_FSSHTTPB_UNBALANCED",
      "The packaging structure does not begin with a start header.",
      from
    );
  }
  yield {
    kind: "start",
    type: first.type,
    compound: first.compound,
    depth: 0,
    offset: first.offset,
    dataOffset: first.offset + first.headerLength,
    dataLength: first.length
  };
  cursor.skip(first.length);
  if (first.compound) open.push(first.type);
  while (open.length > 0) {
    if (cursor.atEnd) {
      throw new OneNoteFormatError(
        "ONENOTE_FSSHTTPB_UNBALANCED",
        `Object type 0x${open[open.length - 1].toString(16)} is never closed.`,
        cursor.position
      );
    }
    if (open.length > MAX_DEPTH2) {
      throw new OneNoteFormatError(
        "ONENOTE_FSSHTTPB_DEPTH",
        "Stream objects nest deeper than this reader will follow.",
        cursor.position
      );
    }
    const mark = cursor.position;
    const header = cursor.readStreamObjectHeader();
    if (header.kind === "end") {
      const closing = open[open.length - 1];
      if (header.type !== closing) {
        throw new OneNoteFormatError(
          "ONENOTE_FSSHTTPB_UNBALANCED",
          `Object type 0x${closing.toString(16)} is closed by an end header for 0x${header.type.toString(16)}.`,
          mark
        );
      }
      open.pop();
      yield {
        kind: "end",
        type: header.type,
        compound: false,
        depth: open.length,
        offset: mark,
        dataOffset: cursor.position,
        dataLength: 0
      };
      continue;
    }
    yield {
      kind: "start",
      type: header.type,
      compound: header.compound,
      depth: open.length,
      offset: mark,
      dataOffset: mark + header.headerLength,
      dataLength: header.length
    };
    cursor.skip(header.length);
    if (header.compound) open.push(header.type);
  }
  checkPadding(window, cursor.position);
}
function checkPadding(window, from) {
  for (let offset = from; offset < window.size; ) {
    const span = Math.min(window.capacity, window.size - offset);
    const chunk = window.peek(offset, span);
    for (let index = 0; index < span; index++) {
      if (chunk[index] !== 0) {
        throw new OneNoteFormatError(
          "ONENOTE_FSSHTTPB_TRAILING",
          "The bytes after the packaging object are not padding.",
          offset + index
        );
      }
    }
    offset += span;
  }
}

// src/storage/paged-key-value-store.ts
import { createHash as createHash3 } from "node:crypto";
import * as nodeFs3 from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath2 from "node:path";
var PAGE_HEADER_BYTES = 8;
var RECORD_HEADER_BYTES = 16;
var BUCKET_ENTRY_BYTES = 8;
var NIL_LINK = 0;
var PagedStoreError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "PagedStoreError";
    this.code = code;
  }
};
var defaultHash = (key) => {
  const digest = createHash3("sha256").update(key).digest();
  return digest.readUInt32LE(0);
};
function positiveSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new PagedStoreError(
      "PAGED_STORE_INVALID_OPTIONS",
      `${name} must be a positive safe integer; received ${value}.`
    );
  }
}
var OUT_OF_SPACE = /* @__PURE__ */ new Set(["ENOSPC", "EDQUOT", "EFBIG", "EROFS"]);
function closeQuietly(fd) {
  if (fd === void 0) return;
  try {
    nodeFs3.closeSync(fd);
  } catch {
  }
}
function errnoOf(error) {
  const code = error?.code;
  return typeof code === "string" ? code : void 0;
}
function rethrowSpace(error, directory, what) {
  const errno = errnoOf(error);
  if (!errno || !OUT_OF_SPACE.has(errno)) throw error;
  const reason = errno === "EDQUOT" ? "a disk quota was reached" : errno === "EROFS" ? "the filesystem is read-only" : "the filesystem is full";
  throw new PagedStoreError(
    errno,
    `The ${what} could not be written because ${reason}: ${directory}. A bounded conversion trades memory for temporary disk, so it needs room there.`
  );
}
function writeAll(fd, data, position, what, directory) {
  let written = 0;
  while (written < data.byteLength) {
    let count;
    try {
      count = nodeFs3.writeSync(fd, data, written, data.byteLength - written, position + written);
    } catch (error) {
      rethrowSpace(error, directory, what);
    }
    if (count === 0) {
      throw new PagedStoreError(
        "PAGED_STORE_SHORT_WRITE",
        `The ${what} accepted only ${written} of ${data.byteLength} bytes at offset ${position}.`
      );
    }
    written += count;
  }
}
function readAll(fd, into, position, what) {
  let read = 0;
  while (read < into.byteLength) {
    const count = nodeFs3.readSync(fd, into, read, into.byteLength - read, position + read);
    if (count === 0) {
      throw new PagedStoreError(
        "PAGED_STORE_TRUNCATED_FILE",
        `The ${what} ended after ${read} of ${into.byteLength} bytes at offset ${position}; the temporary file may have been truncated.`
      );
    }
    read += count;
  }
}
function bytesEqual2(left, right) {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}
var PagedKeyValueStore = class {
  pageSize;
  cacheBudgetBytes;
  bucketCount;
  backingFilePath;
  indexFilePath;
  #directory;
  #pagesFd;
  #indexFd;
  #hash;
  #cache = /* @__PURE__ */ new Map();
  #bucketScratch = new Uint8Array(BUCKET_ENTRY_BYTES);
  #bucketView;
  #pageCount = 0;
  #activePage = -1;
  #uniqueKeys = 0;
  #records = 0;
  #highWaterBytes = 0;
  #copyHighWaterBytes = 0;
  #hits = 0;
  #misses = 0;
  #chainSteps = 0;
  #closed = false;
  constructor({
    pageSize = 64 * 1024,
    cacheBytes = 8 * 1024 * 1024,
    bucketCount = 64 * 1024,
    tempDirectory = nodeOs.tmpdir(),
    keyHash = defaultHash
  } = {}) {
    positiveSafeInteger(pageSize, "pageSize");
    positiveSafeInteger(cacheBytes, "cacheBytes");
    positiveSafeInteger(bucketCount, "bucketCount");
    if (pageSize < PAGE_HEADER_BYTES + RECORD_HEADER_BYTES) {
      throw new PagedStoreError(
        "PAGED_STORE_INVALID_OPTIONS",
        `pageSize must be at least ${PAGE_HEADER_BYTES + RECORD_HEADER_BYTES} bytes.`
      );
    }
    if (cacheBytes < pageSize) {
      throw new PagedStoreError(
        "PAGED_STORE_INVALID_OPTIONS",
        `cacheBytes (${cacheBytes}) must be at least one page (${pageSize} bytes).`
      );
    }
    if (!Number.isSafeInteger(bucketCount * BUCKET_ENTRY_BYTES)) {
      throw new PagedStoreError(
        "PAGED_STORE_INVALID_OPTIONS",
        `bucketCount (${bucketCount}) requires an index file larger than JavaScript can address exactly.`
      );
    }
    this.pageSize = pageSize;
    this.cacheBudgetBytes = cacheBytes;
    this.bucketCount = bucketCount;
    this.#hash = keyHash;
    this.#bucketView = new DataView(this.#bucketScratch.buffer);
    try {
      this.#directory = nodeFs3.mkdtempSync(nodePath2.join(tempDirectory, "one2md-pages-"));
    } catch (error) {
      rethrowSpace(error, tempDirectory, "temporary store directory");
    }
    this.backingFilePath = nodePath2.join(this.#directory, "store.pages");
    this.indexFilePath = nodePath2.join(this.#directory, "store.buckets");
    let pagesFd;
    let indexFd;
    try {
      pagesFd = nodeFs3.openSync(this.backingFilePath, "w+");
      indexFd = nodeFs3.openSync(this.indexFilePath, "w+");
      nodeFs3.ftruncateSync(indexFd, bucketCount * BUCKET_ENTRY_BYTES);
    } catch (error) {
      closeQuietly(pagesFd);
      closeQuietly(indexFd);
      try {
        nodeFs3.rmSync(this.#directory, { recursive: true, force: true });
      } catch {
      }
      rethrowSpace(error, this.#directory, "bucket table");
    }
    this.#pagesFd = pagesFd;
    this.#indexFd = indexFd;
  }
  /** The number of distinct keys held, counting an updated key once. */
  get size() {
    this.#ensureOpen();
    return this.#uniqueKeys;
  }
  get cacheStats() {
    return {
      budgetBytes: this.cacheBudgetBytes,
      residentBytes: this.#cache.size * this.pageSize,
      highWaterBytes: this.#highWaterBytes,
      pages: this.#cache.size,
      hits: this.#hits,
      misses: this.#misses,
      records: this.#records,
      chainSteps: this.#chainSteps,
      copyHighWaterBytes: this.#copyHighWaterBytes
    };
  }
  has(key) {
    return this.#find(key) !== void 0;
  }
  /**
   * The value for a key, as bytes the caller owns.
   *
   * A copy rather than a view into the cached page, and it has to be: the
   * next lookup can evict that page, and a caller holding a view into an
   * evicted page would be reading a buffer that is about to be overwritten
   * by an unrelated page.
   *
   * That copy is an allocation the caller is charged for, and a record fits
   * in a page by construction, so it is at most a page. `recordCopyBytes` in
   * the budget reserves for the several that callers hold at once.
   */
  get(key) {
    const location = this.#find(key);
    if (!location) return void 0;
    const page = this.#loadPage(location.pageNumber);
    const valueOffset = location.offset + RECORD_HEADER_BYTES + location.keyLength;
    const copy = page.slice(valueOffset, valueOffset + location.valueLength);
    if (copy.byteLength > this.#copyHighWaterBytes) this.#copyHighWaterBytes = copy.byteLength;
    return copy;
  }
  /** The largest record any `get` has handed out, for the accounting. */
  get copyHighWaterBytes() {
    return this.#copyHighWaterBytes;
  }
  set(key, value) {
    this.#ensureOpen();
    const recordLength = RECORD_HEADER_BYTES + key.byteLength + value.byteLength;
    const capacity = this.pageSize - PAGE_HEADER_BYTES;
    if (!Number.isSafeInteger(recordLength) || recordLength > capacity) {
      throw new PagedStoreError(
        "PAGED_STORE_RECORD_TOO_LARGE",
        `Key (${key.byteLength} bytes) and value (${value.byteLength} bytes) require ${recordLength} record bytes, but a ${this.pageSize}-byte page holds at most ${capacity}.`
      );
    }
    const bucket = this.#bucketOf(key);
    const head2 = this.#readBucketHead(bucket);
    const replaces = this.#findInChain(key, head2) !== void 0;
    let page = this.#activePage < 0 ? this.#createPage() : this.#loadPage(this.#activePage);
    let view = new DataView(page.buffer, page.byteOffset, page.byteLength);
    let used = view.getUint32(0, true);
    if (used + recordLength > this.pageSize) {
      page = this.#createPage();
      view = new DataView(page.buffer, page.byteOffset, page.byteLength);
      used = PAGE_HEADER_BYTES;
    }
    const pageNumber = this.#activePage;
    view.setUint32(used, key.byteLength, true);
    view.setUint32(used + 4, value.byteLength, true);
    view.setUint32(used + 8, head2 % 4294967296, true);
    view.setUint32(used + 12, Math.floor(head2 / 4294967296), true);
    page.set(key, used + RECORD_HEADER_BYTES);
    page.set(value, used + RECORD_HEADER_BYTES + key.byteLength);
    view.setUint32(0, used + recordLength, true);
    view.setUint32(4, view.getUint32(4, true) + 1, true);
    writeAll(this.#pagesFd, page, pageNumber * this.pageSize, "backing file", this.#directory);
    this.#putCached(pageNumber, page);
    this.#writeBucketHead(bucket, pageNumber * this.pageSize + used + 1);
    this.#records++;
    if (!replaces) this.#uniqueKeys++;
  }
  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#cache.clear();
    nodeFs3.closeSync(this.#pagesFd);
    nodeFs3.closeSync(this.#indexFd);
    nodeFs3.rmSync(this.#directory, { recursive: true, force: true });
  }
  #find(key) {
    this.#ensureOpen();
    return this.#findInChain(key, this.#readBucketHead(this.#bucketOf(key)));
  }
  /** Walks a bucket newest-first, confirming each candidate's key bytes. */
  #findInChain(key, head2) {
    let link = head2;
    while (link !== NIL_LINK) {
      this.#chainSteps++;
      const record = this.#readRecord(link - 1);
      if (record.keyLength === key.byteLength) {
        const page = this.#loadPage(record.pageNumber);
        const stored = page.subarray(
          record.offset + RECORD_HEADER_BYTES,
          record.offset + RECORD_HEADER_BYTES + record.keyLength
        );
        if (bytesEqual2(stored, key)) return record;
      }
      link = record.previous;
    }
    return void 0;
  }
  #readRecord(address) {
    const pageNumber = Math.floor(address / this.pageSize);
    const offset = address % this.pageSize;
    const page = this.#loadPage(pageNumber);
    const view = new DataView(page.buffer, page.byteOffset, page.byteLength);
    const used = view.getUint32(0, true);
    if (offset < PAGE_HEADER_BYTES || offset + RECORD_HEADER_BYTES > used) {
      throw new PagedStoreError(
        "PAGED_STORE_CORRUPT_INDEX",
        `A chain link points at offset ${offset} of page ${pageNumber}, which holds ${used} used bytes.`
      );
    }
    const keyLength = view.getUint32(offset, true);
    const valueLength = view.getUint32(offset + 4, true);
    if (offset + RECORD_HEADER_BYTES + keyLength + valueLength > used) {
      throw new PagedStoreError(
        "PAGED_STORE_CORRUPT_INDEX",
        `A record at offset ${offset} of page ${pageNumber} claims ${keyLength} key and ${valueLength} value bytes, past the page's ${used} used bytes.`
      );
    }
    const previous = view.getUint32(offset + 12, true) * 4294967296 + view.getUint32(offset + 8, true);
    if (!Number.isSafeInteger(previous)) {
      throw new PagedStoreError(
        "PAGED_STORE_CORRUPT_INDEX",
        `A record at offset ${offset} of page ${pageNumber} carries an unreadable chain link.`
      );
    }
    return { address, pageNumber, offset, keyLength, valueLength, previous };
  }
  #bucketOf(key) {
    const hash = this.#hash(key);
    if (!Number.isInteger(hash) || hash < 0 || hash > 4294967295) {
      throw new PagedStoreError(
        "PAGED_STORE_INVALID_HASH",
        `keyHash must return an integer in the uint32 range; received ${hash}.`
      );
    }
    return hash % this.bucketCount;
  }
  #readBucketHead(bucket) {
    readAll(
      this.#indexFd,
      this.#bucketScratch,
      bucket * BUCKET_ENTRY_BYTES,
      "bucket table"
    );
    const link = this.#bucketView.getUint32(4, true) * 4294967296 + this.#bucketView.getUint32(0, true);
    if (!Number.isSafeInteger(link)) {
      throw new PagedStoreError(
        "PAGED_STORE_CORRUPT_INDEX",
        `Bucket ${bucket} holds an unreadable chain head.`
      );
    }
    return link;
  }
  #writeBucketHead(bucket, link) {
    this.#bucketView.setUint32(0, link % 4294967296, true);
    this.#bucketView.setUint32(4, Math.floor(link / 4294967296), true);
    writeAll(
      this.#indexFd,
      this.#bucketScratch,
      bucket * BUCKET_ENTRY_BYTES,
      "bucket table",
      this.#directory
    );
  }
  #createPage() {
    const pageNumber = this.#pageCount++;
    const offset = pageNumber * this.pageSize;
    if (!Number.isSafeInteger(offset + this.pageSize)) {
      throw new PagedStoreError(
        "PAGED_STORE_SIZE_LIMIT",
        `Backing file would exceed JavaScript's safe positional I/O range at page ${pageNumber}.`
      );
    }
    this.#makeRoom();
    const page = new Uint8Array(this.pageSize);
    const view = new DataView(page.buffer);
    view.setUint32(0, PAGE_HEADER_BYTES, true);
    writeAll(this.#pagesFd, page, offset, "backing file", this.#directory);
    this.#activePage = pageNumber;
    this.#putCached(pageNumber, page);
    return page;
  }
  #loadPage(pageNumber) {
    const cached = this.#cache.get(pageNumber);
    if (cached) {
      this.#hits++;
      this.#cache.delete(pageNumber);
      this.#cache.set(pageNumber, cached);
      return cached;
    }
    this.#misses++;
    if (pageNumber < 0 || pageNumber >= this.#pageCount) {
      throw new PagedStoreError(
        "PAGED_STORE_CORRUPT_INDEX",
        `Page ${pageNumber} is outside the ${this.#pageCount} pages written so far.`
      );
    }
    this.#makeRoom();
    const page = new Uint8Array(this.pageSize);
    readAll(this.#pagesFd, page, pageNumber * this.pageSize, "backing file");
    const used = new DataView(page.buffer).getUint32(0, true);
    if (used < PAGE_HEADER_BYTES || used > this.pageSize) {
      throw new PagedStoreError(
        "PAGED_STORE_CORRUPT_PAGE",
        `Page ${pageNumber} reports ${used} used bytes, outside its ${this.pageSize}-byte bounds.`
      );
    }
    this.#putCached(pageNumber, page);
    return page;
  }
  /**
   * Evict until one more page would still fit.
   *
   * Called before a page is allocated rather than after, so the cache is
   * never momentarily a page over its budget. The two are otherwise the same
   * eviction — least recently used first, which is what `Map` iteration order
   * gives once `#loadPage` moves a hit to the end.
   */
  #makeRoom() {
    while ((this.#cache.size + 1) * this.pageSize > this.cacheBudgetBytes) {
      const oldest = this.#cache.keys().next().value;
      if (oldest === void 0) return;
      this.#cache.delete(oldest);
    }
  }
  #putCached(pageNumber, page) {
    this.#cache.delete(pageNumber);
    this.#makeRoom();
    this.#cache.set(pageNumber, page);
    this.#highWaterBytes = Math.max(this.#highWaterBytes, this.#cache.size * this.pageSize);
  }
  #ensureOpen() {
    if (this.#closed) {
      throw new PagedStoreError("PAGED_STORE_CLOSED", "The paged key/value store is closed.");
    }
  }
};

// src/indexing/section-index.ts
function indexedGuidKey(id) {
  return `${id.identifier}:${id.value}`;
}
var DEFAULT_SECTION_INDEX_OPTIONS = {
  cacheBytes: 8 * 1024 * 1024,
  pageSize: 64 * 1024,
  bucketCount: 64 * 1024,
  windowBytes: DEFAULT_WINDOW_BYTES
};
var Tag = {
  revisionByOrder: 1,
  revisionByGuid: 2,
  revisionRoot: 3,
  revisionRole: 4,
  revisionObject: 5,
  objectByOrder: 6,
  objectByGuid: 7,
  fileDataByOrder: 8,
  fileDataByKey: 9,
  globalId: 10
};
var INDEXER_TAG_BASE = 64;
function outOfRange(what, order, count) {
  return new OneNoteFormatError(
    "ONENOTE_INDEX_OUT_OF_RANGE",
    `${what} ${order} was asked for, but the index holds ${count}.`
  );
}
var IndexedSection = class {
  encoding;
  header;
  options;
  window;
  store;
  key = new RecordWriter(64);
  value = new RecordWriter(256);
  #revisionCount = 0;
  #objectCount = 0;
  #fileDataCount = 0;
  #globalIdScopes = 0;
  constructor(encoding, header, window, { reader = DEFAULT_READER_OPTIONS, ...limits } = {}) {
    this.encoding = encoding;
    this.header = header;
    this.options = reader;
    this.window = window;
    this.store = new PagedKeyValueStore({
      pageSize: limits.pageSize ?? DEFAULT_SECTION_INDEX_OPTIONS.pageSize,
      cacheBytes: limits.cacheBytes ?? DEFAULT_SECTION_INDEX_OPTIONS.cacheBytes,
      bucketCount: limits.bucketCount ?? DEFAULT_SECTION_INDEX_OPTIONS.bucketCount,
      tempDirectory: limits.tempDirectory
    });
  }
  get revisionCount() {
    return this.#revisionCount;
  }
  get objectCount() {
    return this.#objectCount;
  }
  get fileDataCount() {
    return this.#fileDataCount;
  }
  get globalIdScopeCount() {
    return this.#globalIdScopes;
  }
  get stats() {
    const cache = this.store.cacheStats;
    return {
      cache,
      windowBytes: this.window.capacity,
      windowRefills: this.window.refills,
      residentBytes: cache.residentBytes + this.window.residentBytes
    };
  }
  read(range) {
    return this.window.read(range.offset, range.length);
  }
  // -- Revisions ----------------------------------------------------------
  /** @internal Appends a revision and returns its order. */
  addRevision(revision) {
    const order = this.#revisionCount++;
    this.#writeRevision({
      ...revision,
      order,
      rootObjectCount: 0,
      roleAssociationCount: 0,
      objectCount: 0
    });
    this.store.set(
      this.key.reset(Tag.revisionByGuid).extendedGuid(revision.id).done(),
      this.value.reset().u32(order).done()
    );
    return order;
  }
  /** @internal */
  hasRevision(id) {
    return this.store.has(this.key.reset(Tag.revisionByGuid).extendedGuid(id).done());
  }
  /** @internal */
  addRootObject(revision, root) {
    const current = this.revisionAt(revision);
    this.store.set(
      this.key.reset(Tag.revisionRoot).u32(revision).u32(current.rootObjectCount).done(),
      this.value.reset().extendedGuid(root.objectId).u32(root.role).done()
    );
    this.#writeRevision({ ...current, rootObjectCount: current.rootObjectCount + 1 });
  }
  /** @internal */
  addRoleAssociation(revision, association) {
    const current = this.revisionAt(revision);
    this.store.set(
      this.key.reset(Tag.revisionRole).u32(revision).u32(current.roleAssociationCount).done(),
      this.value.reset().optionalExtendedGuid(association.contextId).u32(association.role).u32(association.order).done()
    );
    this.#writeRevision({ ...current, roleAssociationCount: current.roleAssociationCount + 1 });
  }
  /** @internal Records the object space a revision belongs to, once known. */
  setObjectSpace(revision, objectSpaceId, contextId) {
    this.#writeRevision({ ...this.revisionAt(revision), objectSpaceId, contextId });
  }
  revisionAt(order) {
    const stored = this.store.get(this.key.reset(Tag.revisionByOrder).u32(order).done());
    if (!stored) throw outOfRange("Revision", order, this.#revisionCount);
    const reader = new RecordReader(stored);
    return {
      order,
      id: reader.extendedGuid(),
      dependencyId: reader.optionalExtendedGuid(),
      role: reader.u32(),
      isEncrypted: reader.flag(),
      contextId: reader.optionalExtendedGuid(),
      objectSpaceId: reader.optionalExtendedGuid(),
      rootObjectCount: reader.u32(),
      roleAssociationCount: reader.u32(),
      objectCount: reader.u32()
    };
  }
  revision(id) {
    const stored = this.store.get(this.key.reset(Tag.revisionByGuid).extendedGuid(id).done());
    return stored ? this.revisionAt(new RecordReader(stored).u32()) : void 0;
  }
  *revisions() {
    for (let order = 0; order < this.#revisionCount; order++) yield this.revisionAt(order);
  }
  *rootObjectsOf(revision) {
    const { rootObjectCount } = this.revisionAt(revision);
    for (let index = 0; index < rootObjectCount; index++) {
      const stored = this.store.get(this.key.reset(Tag.revisionRoot).u32(revision).u32(index).done());
      const reader = new RecordReader(stored);
      yield { objectId: reader.extendedGuid(), role: reader.u32() };
    }
  }
  *roleAssociationsOf(revision) {
    const { roleAssociationCount } = this.revisionAt(revision);
    for (let index = 0; index < roleAssociationCount; index++) {
      const stored = this.store.get(this.key.reset(Tag.revisionRole).u32(revision).u32(index).done());
      const reader = new RecordReader(stored);
      yield { contextId: reader.optionalExtendedGuid(), role: reader.u32(), order: reader.u32() };
    }
  }
  *objectsOf(revision) {
    const { objectCount } = this.revisionAt(revision);
    for (let index = 0; index < objectCount; index++) {
      const stored = this.store.get(this.key.reset(Tag.revisionObject).u32(revision).u32(index).done());
      yield this.objectAt(new RecordReader(stored).u32());
    }
  }
  #writeRevision(revision) {
    this.store.set(
      this.key.reset(Tag.revisionByOrder).u32(revision.order).done(),
      this.value.reset().extendedGuid(revision.id).optionalExtendedGuid(revision.dependencyId).u32(revision.role).flag(revision.isEncrypted).optionalExtendedGuid(revision.contextId).optionalExtendedGuid(revision.objectSpaceId).u32(revision.rootObjectCount).u32(revision.roleAssociationCount).u32(revision.objectCount).done()
    );
  }
  // -- Objects ------------------------------------------------------------
  /** @internal Appends an object and returns its order. */
  addObject(object) {
    if (this.#objectCount >= this.options.maxObjects) {
      throw new OneNoteFormatError(
        "ONENOTE_OBJECT_LIMIT",
        "The object declaration limit was exceeded.",
        object.propertySet?.offset
      );
    }
    const order = this.#objectCount++;
    this.updateObject({ ...object, order });
    this.store.set(
      this.key.reset(Tag.objectByGuid).extendedGuid(object.id).done(),
      this.value.reset().u32(order).done()
    );
    if (object.revisionOrder >= 0) {
      const revision = this.revisionAt(object.revisionOrder);
      this.store.set(
        this.key.reset(Tag.revisionObject).u32(revision.order).u32(revision.objectCount).done(),
        this.value.reset().u32(order).done()
      );
      this.#writeRevision({ ...revision, objectCount: revision.objectCount + 1 });
    }
    return order;
  }
  /** @internal Rewrites an object in place, for a partition seen later. */
  updateObject(object) {
    this.store.set(
      this.key.reset(Tag.objectByOrder).u32(object.order).done(),
      this.value.reset().extendedGuid(object.id).u32(object.jcid).u32(object.referenceCount).i32(object.revisionOrder).optionalExtendedGuid(object.revisionId).flag(object.isRevision).optionalRange(object.propertySet).i32(object.globalIdScope ?? -1).optionalText(object.fileDataReference).optionalText(object.fileExtension).optionalRange(object.objectReferences).u32(object.objectReferenceCount ?? 0).optionalRange(object.cellReferences).u32(object.cellReferenceCount ?? 0).optionalExtendedGuid(object.blobId).done()
    );
  }
  objectAt(order) {
    const stored = this.store.get(this.key.reset(Tag.objectByOrder).u32(order).done());
    if (!stored) throw outOfRange("Object", order, this.#objectCount);
    const reader = new RecordReader(stored);
    const object = {
      order,
      id: reader.extendedGuid(),
      jcid: reader.u32(),
      referenceCount: reader.u32(),
      revisionOrder: reader.i32(),
      revisionId: reader.optionalExtendedGuid(),
      isRevision: reader.flag(),
      propertySet: reader.optionalRange()
    };
    const scope = reader.i32();
    if (scope >= 0) object.globalIdScope = scope;
    object.fileDataReference = reader.optionalText();
    object.fileExtension = reader.optionalText();
    const objectReferences = reader.optionalRange();
    const objectReferenceCount = reader.u32();
    if (objectReferences) {
      object.objectReferences = objectReferences;
      object.objectReferenceCount = objectReferenceCount;
    }
    const cellReferences = reader.optionalRange();
    const cellReferenceCount = reader.u32();
    if (cellReferences) {
      object.cellReferences = cellReferences;
      object.cellReferenceCount = cellReferenceCount;
    }
    object.blobId = reader.optionalExtendedGuid();
    return object;
  }
  /**
   * The object an identifier names.
   *
   * An identifier can be declared in more than one revision — the packaged
   * encoding carries an unchanged object forward, and the desktop encoding
   * revises one in place. This answers with the last declaration indexed,
   * which is the current one; earlier ones are reached through their revision.
   */
  object(id) {
    const stored = this.store.get(this.key.reset(Tag.objectByGuid).extendedGuid(id).done());
    return stored ? this.objectAt(new RecordReader(stored).u32()) : void 0;
  }
  *objects() {
    for (let order = 0; order < this.#objectCount; order++) yield this.objectAt(order);
  }
  // -- File data ----------------------------------------------------------
  /** @internal */
  addFileData(key, payload) {
    const order = this.#fileDataCount++;
    this.store.set(
      this.key.reset(Tag.fileDataByOrder).u32(order).done(),
      this.value.reset().text(key).range(payload).done()
    );
    this.store.set(
      this.key.reset(Tag.fileDataByKey).text(key).done(),
      this.value.reset().u32(order).done()
    );
    return order;
  }
  fileDataAt(order) {
    const stored = this.store.get(this.key.reset(Tag.fileDataByOrder).u32(order).done());
    if (!stored) throw outOfRange("File data", order, this.#fileDataCount);
    const reader = new RecordReader(stored);
    return { order, key: reader.text(), payload: reader.range() };
  }
  fileData(key) {
    const stored = this.store.get(this.key.reset(Tag.fileDataByKey).text(key).done());
    return stored ? this.fileDataAt(new RecordReader(stored).u32()) : void 0;
  }
  *fileDataObjects() {
    for (let order = 0; order < this.#fileDataCount; order++) yield this.fileDataAt(order);
  }
  // -- Global identification ----------------------------------------------
  /**
   * @internal Opens a scope.
   *
   * A desktop global-identification table is cleared and refilled as the walk
   * moves between file-node lists, and a CompactID means whatever the table
   * said at the moment its object was declared. Clearing therefore cannot
   * mean deleting: an object indexed earlier still refers to the old entries.
   * Each clear opens a new scope instead, and an object records which one it
   * was declared under.
   */
  openGlobalIdScope() {
    return this.#globalIdScopes++;
  }
  /** @internal */
  addGlobalId(scope, index, identifier) {
    this.store.set(
      this.key.reset(Tag.globalId).u32(scope).u32(index).done(),
      this.value.reset().guid(identifier).done()
    );
  }
  /** @internal */
  hasGlobalId(scope, index) {
    return this.store.has(this.key.reset(Tag.globalId).u32(scope).u32(index).done());
  }
  globalId(scope, index) {
    const stored = this.store.get(this.key.reset(Tag.globalId).u32(scope).u32(index).done());
    return stored ? new RecordReader(stored).guid() : void 0;
  }
  /**
   * A scope's global-identification table, as `readPropertySet` expects it.
   *
   * That reader wants a `Map`, and the whole point of the index is that this
   * table is not one — it is on disk, and a table with a hundred thousand
   * entries must not become a hundred thousand heap entries just to decode one
   * object. So this is a `Map` that answers from the store instead of from
   * itself, which is all the reader ever asks of it.
   */
  globalIdTable(scope) {
    return new GlobalIdTable(this, scope);
  }
  close() {
    this.store.close();
  }
};
var GlobalIdTable = class extends Map {
  #index;
  #scope;
  constructor(index, scope) {
    super();
    this.#index = index;
    this.#scope = scope;
  }
  get(index) {
    return this.#index.globalId(this.#scope, index);
  }
  has(index) {
    return this.#index.hasGlobalId(this.#scope, index);
  }
};

// src/indexing/fsshttpb-index.ts
var Tag2 = {
  manifestMapping: INDEXER_TAG_BASE,
  cellMapping: INDEXER_TAG_BASE + 1,
  revisionMapping: INDEXER_TAG_BASE + 2,
  manifestRoot: INDEXER_TAG_BASE + 3,
  cellManifest: INDEXER_TAG_BASE + 4,
  revisionOfElement: INDEXER_TAG_BASE + 5,
  revisionGroup: INDEXER_TAG_BASE + 6,
  objectGroupByOrder: INDEXER_TAG_BASE + 7,
  objectGroupByElement: INDEXER_TAG_BASE + 8,
  groupDeclaration: INDEXER_TAG_BASE + 9,
  groupData: INDEXER_TAG_BASE + 10,
  accumulated: INDEXER_TAG_BASE + 11,
  placed: INDEXER_TAG_BASE + 12
};
var EMPTY_VALUE = new Uint8Array(0);
function missing(what, type, event) {
  return new OneNoteFormatError(
    "ONENOTE_FSSHTTPB_MISSING_STRUCTURE",
    `Expected ${what} (0x${type.toString(16)}) but found ` + (event ? `0x${event.type.toString(16)}` : "nothing") + ".",
    event?.offset
  );
}
function expect2(event, type, what) {
  if (event.type !== type) throw missing(what, type, event);
}
var PackageIndexedSection = class extends IndexedSection {
  /** The cell schema the storage manifest declares. */
  schema = "";
  manifestMappingCount = 0;
  cellMappingCount = 0;
  revisionMappingCount = 0;
  manifestRootCount = 0;
  objectGroupCount = 0;
  manifestMappingAt(position) {
    const reader = this.#at(Tag2.manifestMapping, position, "A manifest mapping");
    return { id: reader.extendedGuid(), serial: readSerial2(reader) };
  }
  cellMappingAt(position) {
    const reader = this.#at(Tag2.cellMapping, position, "A cell mapping");
    return { cell: readCell(reader), id: reader.extendedGuid(), serial: readSerial2(reader) };
  }
  revisionMappingAt(position) {
    const reader = this.#at(Tag2.revisionMapping, position, "A revision mapping");
    return { revision: reader.extendedGuid(), id: reader.extendedGuid(), serial: readSerial2(reader) };
  }
  manifestRootAt(position) {
    const reader = this.#at(Tag2.manifestRoot, position, "A storage manifest root");
    return { root: reader.extendedGuid(), cell: readCell(reader) };
  }
  *manifestMappings() {
    for (let index = 0; index < this.manifestMappingCount; index++) yield this.manifestMappingAt(index);
  }
  *cellMappings() {
    for (let index = 0; index < this.cellMappingCount; index++) yield this.cellMappingAt(index);
  }
  *revisionMappings() {
    for (let index = 0; index < this.revisionMappingCount; index++) yield this.revisionMappingAt(index);
  }
  *manifestRoots() {
    for (let index = 0; index < this.manifestRootCount; index++) yield this.manifestRootAt(index);
  }
  /** The revision a cell manifest element declares current. */
  cellManifest(element) {
    const stored = this.store.get(this.key.reset(Tag2.cellManifest).extendedGuid(element).done());
    return stored ? new RecordReader(stored).extendedGuid() : void 0;
  }
  /** Which indexed revision a revision-manifest data element became. */
  revisionOfElement(element) {
    const stored = this.store.get(this.key.reset(Tag2.revisionOfElement).extendedGuid(element).done());
    return stored ? new RecordReader(stored).u32() : void 0;
  }
  /** The object-group elements a revision names, in declared order. */
  *objectGroupsOf(revision) {
    const count = this.#counter(Tag2.revisionGroup, revision);
    for (let index = 0; index < count; index++) {
      const stored = this.store.get(this.key.reset(Tag2.revisionGroup).u32(revision).u32(index).done());
      yield new RecordReader(stored).extendedGuid();
    }
  }
  objectGroupCountOf(revision) {
    return this.#counter(Tag2.revisionGroup, revision);
  }
  objectGroupAt(order) {
    const stored = this.store.get(this.key.reset(Tag2.objectGroupByOrder).u32(order).done());
    if (!stored) {
      throw new OneNoteFormatError(
        "ONENOTE_INDEX_OUT_OF_RANGE",
        `Object group ${order} was asked for, but the index holds ${this.objectGroupCount}.`
      );
    }
    const reader = new RecordReader(stored);
    return { order, id: reader.extendedGuid(), declarationCount: reader.u32(), dataCount: reader.u32() };
  }
  objectGroup(element) {
    const stored = this.store.get(this.key.reset(Tag2.objectGroupByElement).extendedGuid(element).done());
    return stored ? this.objectGroupAt(new RecordReader(stored).u32()) : void 0;
  }
  *objectGroups() {
    for (let order = 0; order < this.objectGroupCount; order++) yield this.objectGroupAt(order);
  }
  declarationAt(group, position) {
    const stored = this.store.get(this.key.reset(Tag2.groupDeclaration).u32(group).u32(position).done());
    if (!stored) {
      throw new OneNoteFormatError(
        "ONENOTE_INDEX_OUT_OF_RANGE",
        `Declaration ${position} of object group ${group} is not in the index.`
      );
    }
    const reader = new RecordReader(stored);
    return {
      object: reader.extendedGuid(),
      blob: reader.optionalExtendedGuid(),
      partition: reader.big(),
      dataSize: reader.optionalBig(),
      objectReferenceCount: reader.big(),
      cellReferenceCount: reader.big()
    };
  }
  objectDataAt(group, position) {
    const stored = this.store.get(this.key.reset(Tag2.groupData).u32(group).u32(position).done());
    if (!stored) {
      throw new OneNoteFormatError(
        "ONENOTE_INDEX_OUT_OF_RANGE",
        `Object data ${position} of object group ${group} is not in the index.`
      );
    }
    const reader = new RecordReader(stored);
    return {
      objectReferences: { count: reader.big(), range: reader.range() },
      cellReferences: { count: reader.big(), range: reader.range() },
      data: reader.optionalRange(),
      blob: reader.optionalExtendedGuid()
    };
  }
  /**
   * [MS-FSSHTTPB] 2.2.1.8 — a counted Extended GUID array, decoded on demand.
   *
   * The packaged encoding has no global-identification table: an object's
   * CompactIDs are resolved against its own reference arrays, positionally.
   * Those are what the next stage pairs with the CompactIDs in the property
   * set, and pass `ObjectDescriptor.objectReferences` to read them — the
   * array is decoded from the file now rather than held since indexing.
   */
  *extendedGuidsIn(range) {
    if (!range) return;
    const cursor = this.#cursorOver(range);
    const count = cursor.readCompactUint();
    for (let index = 0; index < count; index++) yield cursor.readExtendedGuid();
  }
  /** [MS-FSSHTTPB] 2.2.1.11 — the cell-identifier array beside it. */
  *cellIdsIn(range) {
    if (!range) return;
    const cursor = this.#cursorOver(range);
    const count = cursor.readCompactUint();
    for (let index = 0; index < count; index++) yield cursor.readCellId();
  }
  #cursorOver(range) {
    return new SourceCursor(this.window, range.offset, range.offset + range.length);
  }
  /** @internal */
  bumpCounter(tag, scope) {
    const next = this.#counter(tag, scope);
    this.store.set(
      this.key.reset(tag).u32(scope).done(),
      this.value.reset().u32(next + 1).done()
    );
    return next;
  }
  #counter(tag, scope) {
    const stored = this.store.get(this.key.reset(tag).u32(scope).done());
    return stored ? new RecordReader(stored).u32() : 0;
  }
  #at(tag, position, what) {
    const stored = this.store.get(this.key.reset(tag).u32(position).done());
    if (!stored) {
      throw new OneNoteFormatError("ONENOTE_INDEX_OUT_OF_RANGE", `${what} ${position} is not in the index.`);
    }
    return new RecordReader(stored);
  }
};
function readSerial2(reader) {
  return { identifier: reader.guid(), value: reader.big() };
}
function readCell(reader) {
  return { first: reader.extendedGuid(), second: reader.extendedGuid() };
}
var PackageIndexer = class {
  #index;
  #window;
  #sawPackage = false;
  #inPackage = false;
  #sawStorageIndex = false;
  #sawStorageManifest = false;
  #element;
  #section;
  constructor(index) {
    this.#index = index;
    this.#window = index.window;
  }
  run() {
    for (const event of walkStreamObjects(this.#window)) {
      if (event.kind === "end") this.#end(event);
      else this.#start(event);
    }
    if (!this.#sawStorageIndex) {
      throw new OneNoteFormatError(
        "ONENOTE_FSSHTTPB_NO_STORAGE_INDEX",
        "The data element package has no storage index."
      );
    }
    if (!this.#sawStorageManifest) {
      throw new OneNoteFormatError(
        "ONENOTE_FSSHTTPB_NO_STORAGE_MANIFEST",
        "The data element package has no storage manifest."
      );
    }
    this.#accumulateObjects();
  }
  // -- The event state machine --------------------------------------------
  #start(event) {
    switch (event.depth) {
      case 0:
        break;
      case 1:
        if (this.#sawPackage) break;
        this.#sawPackage = true;
        expect2(event, 21 /* DataElementPackage */, "a data element package");
        this.#inPackage = true;
        break;
      case 2:
        if (this.#inPackage) this.#beginElement(event);
        break;
      case 3:
        if (this.#element) this.#elementChild(event);
        break;
      case 4:
        if (this.#element && this.#section !== void 0) this.#sectionChild(event);
        break;
      default:
        break;
    }
  }
  #end(event) {
    if (event.depth === 1) this.#inPackage = false;
    else if (event.depth === 2 && this.#element) this.#finishElement();
    else if (event.depth === 3) this.#section = void 0;
  }
  /** [MS-FSSHTTPB] 2.2.1.12.2 — one data element's identity. */
  #beginElement(event) {
    if (event.type !== DATA_ELEMENT_TYPE) {
      throw new OneNoteFormatError(
        "ONENOTE_FSSHTTPB_NOT_DATA_ELEMENT",
        `Stream object type 0x${event.type.toString(16)} is not a data element.`,
        event.offset
      );
    }
    const cursor = new SourceCursor(this.#window, event.dataOffset, event.dataOffset + event.dataLength);
    const id = cursor.readExtendedGuid();
    cursor.readSerialNumber();
    const type = cursor.readCompactUint();
    if (!cursor.atEnd) {
      throw new OneNoteFormatError(
        "ONENOTE_FSSHTTPB_DATA_ELEMENT_LENGTH",
        `A data element declares ${event.dataLength} bytes but its header uses ${cursor.position - event.dataOffset}.`,
        event.dataOffset
      );
    }
    if (!(type in DataElementType)) {
      throw new OneNoteFormatError(
        "ONENOTE_FSSHTTPB_DATA_ELEMENT_TYPE",
        `Data element type ${type} is not one this reader knows.`,
        event.dataOffset
      );
    }
    this.#element = { id, type, childIndex: 0, group: -1, revision: -1 };
    if (type === 1 /* StorageIndex */) this.#sawStorageIndex = true;
    if (type === 2 /* StorageManifest */) this.#sawStorageManifest = true;
    if (type === 5 /* ObjectGroup */) {
      const order = this.#index.objectGroupCount++;
      this.#element.group = order;
      this.#index.store.set(
        this.#index.key.reset(Tag2.objectGroupByElement).extendedGuid(id).done(),
        this.#index.value.reset().u32(order).done()
      );
      this.#writeObjectGroup(order, id, 0, 0);
    }
    if (!event.compound) this.#finishElement();
  }
  #finishElement() {
    const element = this.#element;
    this.#element = void 0;
    this.#section = void 0;
    if (element.childIndex > 0) return;
    switch (element.type) {
      case 2 /* StorageManifest */:
        throw missing("a schema GUID", 12 /* StorageManifestSchemaGuid */);
      case 3 /* CellManifest */:
        throw missing("a current revision", 11 /* CellManifestCurrentRevision */);
      case 4 /* RevisionManifest */:
        throw missing("a revision manifest", 26 /* RevisionManifest */);
      case 10 /* ObjectDataBlob */:
        throw missing("a BLOB payload", 2 /* ObjectDataBlob */);
      default:
        break;
    }
  }
  #elementChild(event) {
    const element = this.#element;
    switch (element.type) {
      case 1 /* StorageIndex */:
        this.#readStorageIndexMapping(event);
        break;
      case 2 /* StorageManifest */:
        this.#readStorageManifestChild(event, element);
        break;
      case 3 /* CellManifest */:
        if (element.childIndex === 0) {
          expect2(event, 11 /* CellManifestCurrentRevision */, "a current revision");
          const revision = this.#exact(event, (cursor) => cursor.readExtendedGuid());
          this.#index.store.set(
            this.#index.key.reset(Tag2.cellManifest).extendedGuid(element.id).done(),
            this.#index.value.reset().extendedGuid(revision).done()
          );
        }
        break;
      case 4 /* RevisionManifest */:
        this.#readRevisionManifestChild(event, element);
        break;
      case 5 /* ObjectGroup */:
        if (event.type !== 29 /* ObjectGroupDeclarations */ && event.type !== 30 /* ObjectGroupData */) {
          throw new OneNoteFormatError(
            "ONENOTE_FSSHTTPB_MISSING_STRUCTURE",
            `An object group cannot hold a 0x${event.type.toString(16)}.`,
            event.offset
          );
        }
        this.#section = event.type;
        break;
      case 10 /* ObjectDataBlob */:
        if (element.childIndex === 0) {
          expect2(event, 2 /* ObjectDataBlob */, "a BLOB payload");
          this.#index.addFileData(indexedGuidKey(element.id), {
            offset: event.dataOffset,
            length: event.dataLength
          });
        }
        break;
      default:
        break;
    }
    element.childIndex++;
  }
  #readStorageIndexMapping(event) {
    const index = this.#index;
    switch (event.type) {
      case 17 /* StorageIndexManifestMapping */: {
        const mapping = this.#exact(event, (cursor) => ({
          id: cursor.readExtendedGuid(),
          serial: cursor.readSerialNumber()
        }));
        index.store.set(
          index.key.reset(Tag2.manifestMapping).u32(index.manifestMappingCount++).done(),
          index.value.reset().extendedGuid(mapping.id).guid(mapping.serial.identifier).big(mapping.serial.value).done()
        );
        break;
      }
      case 14 /* StorageIndexCellMapping */: {
        const mapping = this.#exact(event, (cursor) => ({
          cell: cursor.readCellId(),
          id: cursor.readExtendedGuid(),
          serial: cursor.readSerialNumber()
        }));
        index.store.set(
          index.key.reset(Tag2.cellMapping).u32(index.cellMappingCount++).done(),
          index.value.reset().extendedGuid(mapping.cell.first).extendedGuid(mapping.cell.second).extendedGuid(mapping.id).guid(mapping.serial.identifier).big(mapping.serial.value).done()
        );
        break;
      }
      case 13 /* StorageIndexRevisionMapping */: {
        const mapping = this.#exact(event, (cursor) => ({
          revision: cursor.readExtendedGuid(),
          id: cursor.readExtendedGuid(),
          serial: cursor.readSerialNumber()
        }));
        index.store.set(
          index.key.reset(Tag2.revisionMapping).u32(index.revisionMappingCount++).done(),
          index.value.reset().extendedGuid(mapping.revision).extendedGuid(mapping.id).guid(mapping.serial.identifier).big(mapping.serial.value).done()
        );
        break;
      }
      default:
        throw new OneNoteFormatError(
          "ONENOTE_FSSHTTPB_MISSING_STRUCTURE",
          `A storage index cannot hold a 0x${event.type.toString(16)}.`,
          event.offset
        );
    }
  }
  #readStorageManifestChild(event, element) {
    if (element.childIndex === 0) {
      expect2(event, 12 /* StorageManifestSchemaGuid */, "a schema GUID");
      this.#index.schema = this.#exact(event, (cursor) => cursor.readGuid());
      return;
    }
    expect2(event, 7 /* StorageManifestRootDeclare */, "a root declaration");
    const root = this.#exact(event, (cursor) => ({
      root: cursor.readExtendedGuid(),
      cell: cursor.readCellId()
    }));
    this.#index.store.set(
      this.#index.key.reset(Tag2.manifestRoot).u32(this.#index.manifestRootCount++).done(),
      this.#index.value.reset().extendedGuid(root.root).extendedGuid(root.cell.first).extendedGuid(root.cell.second).done()
    );
  }
  #readRevisionManifestChild(event, element) {
    const index = this.#index;
    if (element.childIndex === 0) {
      expect2(event, 26 /* RevisionManifest */, "a revision manifest");
      const head2 = this.#exact(event, (cursor) => ({
        revision: cursor.readExtendedGuid(),
        baseRevision: cursor.readExtendedGuid()
      }));
      element.revision = index.addRevision({
        id: head2.revision,
        dependencyId: isNullExtendedGuid(head2.baseRevision) ? void 0 : head2.baseRevision,
        // A packaged revision carries neither: its role comes from being
        // a cell's current revision, and the encoding has no encrypted
        // form. The next stage assigns both from the cell chain.
        role: 0,
        isEncrypted: false
      });
      index.store.set(
        index.key.reset(Tag2.revisionOfElement).extendedGuid(element.id).done(),
        index.value.reset().u32(element.revision).done()
      );
      return;
    }
    switch (event.type) {
      case 10 /* RevisionManifestRootDeclare */: {
        const declared = this.#exact(event, (cursor) => ({
          root: cursor.readExtendedGuid(),
          object: cursor.readExtendedGuid()
        }));
        index.addRootObject(element.revision, { objectId: declared.object, role: declared.root.value });
        break;
      }
      case 25 /* RevisionManifestObjectGroupReference */: {
        const group = this.#exact(event, (cursor) => cursor.readExtendedGuid());
        const position = index.bumpCounter(Tag2.revisionGroup, element.revision);
        index.store.set(
          index.key.reset(Tag2.revisionGroup).u32(element.revision).u32(position).done(),
          index.value.reset().extendedGuid(group).done()
        );
        break;
      }
      default:
        throw new OneNoteFormatError(
          "ONENOTE_FSSHTTPB_MISSING_STRUCTURE",
          `A revision manifest cannot hold a 0x${event.type.toString(16)}.`,
          event.offset
        );
    }
  }
  #sectionChild(event) {
    const element = this.#element;
    const index = this.#index;
    const group = index.objectGroupAt(element.group);
    if (this.#section === 29 /* ObjectGroupDeclarations */) {
      const isBlobReference2 = event.type === 5 /* ObjectGroupObjectDeclareBlobReference */;
      if (!isBlobReference2) expect2(event, 24 /* ObjectGroupObjectDeclare */, "an object declaration");
      const declaration = this.#exact(event, (cursor) => ({
        object: cursor.readExtendedGuid(),
        // A blob reference names its payload element instead of
        // carrying a size, so the two forms differ by one field each.
        blob: isBlobReference2 ? cursor.readExtendedGuid() : void 0,
        partition: cursor.readCompactUint(),
        dataSize: isBlobReference2 ? void 0 : cursor.readCompactUint(),
        objectReferenceCount: cursor.readCompactUint(),
        cellReferenceCount: cursor.readCompactUint()
      }));
      index.store.set(
        index.key.reset(Tag2.groupDeclaration).u32(group.order).u32(group.declarationCount).done(),
        index.value.reset().extendedGuid(declaration.object).optionalExtendedGuid(declaration.blob).big(declaration.partition).optionalBig(declaration.dataSize).big(declaration.objectReferenceCount).big(declaration.cellReferenceCount).done()
      );
      this.#writeObjectGroup(group.order, group.id, group.declarationCount + 1, group.dataCount);
      return;
    }
    const isBlobReference = event.type === 28 /* ObjectGroupObjectDataBlobReference */;
    if (!isBlobReference) expect2(event, 22 /* ObjectGroupObjectData */, "object data");
    const data = this.#exact(event, (cursor) => {
      const objectReferences = cursor.skipExtendedGuidArray();
      const cellReferences = cursor.skipCellIdArray();
      return {
        objectReferences,
        cellReferences,
        payload: isBlobReference ? void 0 : cursor.readBinaryItemRange(),
        blob: isBlobReference ? cursor.readExtendedGuid() : void 0
      };
    });
    index.store.set(
      index.key.reset(Tag2.groupData).u32(group.order).u32(group.dataCount).done(),
      index.value.reset().big(data.objectReferences.count).range(data.objectReferences.range).big(data.cellReferences.count).range(data.cellReferences.range).optionalRange(data.payload).optionalExtendedGuid(data.blob).done()
    );
    this.#writeObjectGroup(group.order, group.id, group.declarationCount, group.dataCount + 1);
  }
  #writeObjectGroup(order, id, declarationCount, dataCount) {
    this.#index.store.set(
      this.#index.key.reset(Tag2.objectGroupByOrder).u32(order).done(),
      this.#index.value.reset().extendedGuid(id).u32(declarationCount).u32(dataCount).done()
    );
  }
  /**
   * Read one stream object's data, insisting the fields consume all of it.
   *
   * The same contract `readExact` enforces, for the same reason: the format
   * has no padding to hide a mistake in, so stopping short means a field was
   * read too narrow and running over means too wide.
   */
  #exact(event, read) {
    const cursor = new SourceCursor(this.#window, event.dataOffset, event.dataOffset + event.dataLength);
    const value = read(cursor);
    if (!cursor.atEnd) {
      throw new OneNoteFormatError(
        "ONENOTE_FSSHTTPB_STRUCTURE_LENGTH",
        `Stream object 0x${event.type.toString(16)} declares ${event.dataLength} bytes but its fields used ${cursor.position - event.dataOffset}.`,
        event.dataOffset
      );
    }
    return value;
  }
  // -- Reassembling objects from partitions -------------------------------
  /**
   * Merge each revision's object groups into whole objects.
   *
   * An object group is named by a revision but can sit anywhere in the
   * package, so this runs once the elements are all indexed. Both sides of it
   * are on disk: the declarations and data are read back by range, and the
   * partial object being built is the index record itself, rewritten as each
   * partition arrives.
   */
  #accumulateObjects() {
    const index = this.#index;
    for (let revision = 0; revision < index.revisionCount; revision++) {
      for (const groupId of index.objectGroupsOf(revision)) {
        const group = index.objectGroup(groupId);
        if (!group) continue;
        for (let position = 0; position < group.declarationCount; position++) {
          if (position >= group.dataCount) continue;
          this.#merge(revision, index.declarationAt(group.order, position), index.objectDataAt(group.order, position));
        }
      }
    }
  }
  #merge(revision, declaration, data) {
    const index = this.#index;
    const object = this.#objectFor(revision, declaration.object);
    object.referenceCount = Math.max(
      object.referenceCount,
      declaration.objectReferenceCount + declaration.cellReferenceCount
    );
    switch (declaration.partition) {
      case 4 /* ObjectMetadata */: {
        if (data.data?.length !== 4) {
          throw new OneNoteFormatError(
            "ONENOTE_FSSHTTPB_JCID",
            "Object metadata is not a four-byte type code.",
            data.data?.offset
          );
        }
        const bytes = this.#window.peek(data.data.offset, 4);
        object.jcid = (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
        break;
      }
      case 1 /* ObjectData */:
        object.propertySet = data.data;
        object.objectReferences = data.objectReferences.range;
        object.objectReferenceCount = data.objectReferences.count;
        object.cellReferences = data.cellReferences.range;
        object.cellReferenceCount = data.cellReferences.count;
        break;
      case 2 /* ObjectFileData */:
        object.blobId = data.blob ?? declaration.blob;
        break;
      default:
        break;
    }
    index.updateObject(object);
  }
  /** The object being assembled for this identity in this revision. */
  #objectFor(revision, id) {
    const index = this.#index;
    const existing = index.store.get(index.key.reset(Tag2.accumulated).u32(revision).extendedGuid(id).done());
    if (existing) return index.objectAt(new RecordReader(existing).u32());
    const placedKey = index.key.reset(Tag2.placed).extendedGuid(id).done();
    const isRevision = index.store.has(placedKey);
    index.store.set(placedKey, EMPTY_VALUE);
    const order = index.addObject({
      id,
      jcid: 0,
      referenceCount: 0,
      revisionOrder: revision,
      revisionId: index.revisionAt(revision).id,
      isRevision
    });
    index.store.set(
      index.key.reset(Tag2.accumulated).u32(revision).extendedGuid(id).done(),
      index.value.reset().u32(order).done()
    );
    return index.objectAt(order);
  }
};
function indexPackage(header, window, options = {}) {
  const index = new PackageIndexedSection("file-synchronization-package", header, window, options);
  try {
    new PackageIndexer(index).run();
  } catch (error) {
    index.close();
    throw error;
  }
  return index;
}

// src/indexing/onestore-index.ts
var FRAGMENT_HEADER_LENGTH2 = 16;
var FRAGMENT_TRAILER_LENGTH2 = 20;
var TRANSACTION_ENTRY_LENGTH2 = 8;
var NEXT_FRAGMENT_LENGTH2 = 12;
var FILE_DATA_HEADER2 = "bde316e7-2665-4511-a4c4-8d4d0b7a9eac";
var FILE_DATA_FOOTER2 = "71fba722-0f79-4a0b-bb13-899256426b24";
var ONE_POLYNOMIAL2 = 3988292384;
var MSO_POLYNOMIAL2 = 175;
var BASE_TYPES2 = ["inline", "data-reference", "file-node-list-reference"];
var MAX_LIST_NESTING = 1024;
var NO_REVISION = -1;
var EMPTY_VALUE2 = new Uint8Array(0);
var Tag3 = {
  transactionCount: INDEXER_TAG_BASE,
  transactionFragment: INDEXER_TAG_BASE + 1,
  visitedList: INDEXER_TAG_BASE + 2,
  listFragment: INDEXER_TAG_BASE + 3,
  knownJcid: INDEXER_TAG_BASE + 4
};
function continueCrc2(crc, data, count, fileKind) {
  if (fileKind === "section") {
    let state2 = ~crc >>> 0;
    for (let index = 0; index < count; index++) {
      state2 = (state2 ^ data[index]) >>> 0;
      for (let bit = 0; bit < 8; bit++) state2 = (state2 >>> 1 ^ ((state2 & 1) !== 0 ? ONE_POLYNOMIAL2 : 0)) >>> 0;
    }
    return ~state2 >>> 0;
  }
  let state = crc >>> 0;
  for (let index = 0; index < count; index++) {
    state = (state ^ data[index] << 24) >>> 0;
    for (let bit = 0; bit < 8; bit++) state = (state << 1 >>> 0 ^ ((state & 2147483648) !== 0 ? MSO_POLYNOMIAL2 : 0)) >>> 0;
  }
  return state;
}
function bytesMatch(data, offset, expected) {
  for (let index = 0; index < expected.length; index++) {
    if (data[offset + index] !== expected[index]) return false;
  }
  return true;
}
function readExtendedGuidAt2(data, offset) {
  return { identifier: readGuid(data, offset), value: readUInt322(data, offset + 16) };
}
function isEmptyGuid2(id) {
  return id.identifier === EMPTY_GUID && id.value === 0;
}
function guidKey(id) {
  return `${id.identifier}:${id.value}`;
}
function readByte2(data, offset) {
  if (offset < 0 || offset >= data.length) {
    throw new OneNoteFormatError(
      "ONENOTE_TRUNCATED_STRUCTURE",
      "The OneNote file ended before a required structure could be read.",
      offset
    );
  }
  return data[offset];
}
function readStorageString2(data, position, absoluteOffset) {
  const characterCount = readUInt322(data, position);
  position += 4;
  if (characterCount > 1073741823 || position > data.length - characterCount * 2) {
    throw new OneNoteFormatError(
      "ONENOTE_STORAGE_STRING",
      "A StringInStorageBuffer length exceeds its containing structure.",
      absoluteOffset + position - 4
    );
  }
  return {
    value: new TextDecoder("utf-16le").decode(data.subarray(position, position + characterCount * 2)),
    next: position + characterCount * 2
  };
}
function multiplyByEight2(value, offset) {
  if (value > Number.MAX_SAFE_INTEGER / 8) {
    throw new OneNoteFormatError(
      "ONENOTE_COMPRESSED_REFERENCE_OVERFLOW",
      "A compressed chunk reference overflows its decoded range.",
      offset
    );
  }
  return value * 8;
}
function readChunkReference2(data, stpFormat, cbFormat, absoluteOffset) {
  const stpBytes = stpFormat === 0 ? 8 : stpFormat === 2 ? 2 : 4;
  const cbBytes = cbFormat === 0 ? 4 : cbFormat === 1 ? 8 : cbFormat === 2 ? 1 : 2;
  const encodedLength = stpBytes + cbBytes;
  if (isAllOnes(data, 0, stpBytes) && readUnsigned(data, stpBytes, cbBytes) === 0) {
    return { offset: 0, length: 0, isNil: true, encodedLength };
  }
  const rawOffset = readUnsigned(data, 0, stpBytes);
  const rawLength = readUnsigned(data, stpBytes, cbBytes);
  return {
    offset: stpFormat >= 2 ? multiplyByEight2(rawOffset, absoluteOffset) : rawOffset,
    length: cbFormat >= 2 ? multiplyByEight2(rawLength, absoluteOffset + stpBytes) : rawLength,
    isNil: false,
    encodedLength
  };
}
function isRealChunk(chunk) {
  return chunk !== void 0 && !chunk.isNil && !(chunk.offset === 0 && chunk.length === 0);
}
var RevisionStoreIndexer = class {
  #index;
  #window;
  #header;
  #declaredFileLength;
  #key = new RecordWriter(48);
  #value = new RecordWriter(48);
  #totalNodes = 0;
  #fragmentScopes = 0;
  #nextRoleAssociationOrder = 0;
  #totalAssetBytes = 0;
  constructor(index) {
    this.#index = index;
    this.#window = index.window;
    this.#header = index.header;
    this.#declaredFileLength = index.header.expectedFileLength;
  }
  run() {
    this.#indexTransactionLog();
    const root = this.#header.rootFileNodeList;
    this.#validateRootList(root);
    this.#markVisitedList(root.offset);
    const frames = [{
      nodes: this.#fileNodes(root),
      scope: this.#index.openGlobalIdScope(),
      revisionOrder: NO_REVISION
    }];
    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      const next = frame.nodes.next();
      if (next.done) {
        frames.pop();
        continue;
      }
      const node = next.value;
      if (++this.#totalNodes > this.#index.options.maxFileNodes) {
        throw new OneNoteFormatError("ONENOTE_FILE_NODE_LIMIT", "The file-node limit was exceeded.", node.fileOffset);
      }
      this.#processNode(node, frame);
      if (node.baseType !== "file-node-list-reference" || !isRealChunk(node.chunkReference)) continue;
      if (this.#visitedList(node.chunkReference.offset)) continue;
      this.#markVisitedList(node.chunkReference.offset);
      if (frames.length >= MAX_LIST_NESTING) {
        throw new OneNoteFormatError(
          "ONENOTE_FILE_NODE_LIST_DEPTH",
          `Referenced file-node lists nest deeper than the ${MAX_LIST_NESTING} levels this reader will follow.`,
          node.fileOffset
        );
      }
      const inherited = node.id === FileNodeId.objectGroupListReference ? frame.revisionOrder : NO_REVISION;
      frames.push({
        nodes: this.#fileNodes({
          offset: node.chunkReference.offset,
          length: node.chunkReference.length,
          isNil: false
        }),
        scope: this.#index.openGlobalIdScope(),
        revisionOrder: inherited,
        objectSpaceId: inherited === NO_REVISION ? void 0 : this.#index.revisionAt(inherited).objectSpaceId
      });
    }
  }
  // -- Transaction log ----------------------------------------------------
  /**
   * The committed node count for each file-node list, accumulated on disk.
   *
   * The log is append-only and a list's count only ever rises, so the last
   * entry for a list wins. There can be one entry per list per transaction,
   * which is why neither the counts nor the fragments already visited can be
   * a heap map.
   */
  #indexTransactionLog() {
    const { transactionLog, transactionCount, fileKind } = this.#header;
    const options = this.#index.options;
    if (!transactionLog || transactionCount === void 0) {
      throw new OneNoteFormatError(
        "ONENOTE_TRANSACTION_LOG_HEADER",
        "The revision-store header does not expose a complete transaction log reference."
      );
    }
    let current = transactionLog;
    let completedTransactions = 0;
    let fragmentCount = 0;
    let entryCount = 0;
    let runningCrc = 0;
    let listCount = 0;
    while (completedTransactions < transactionCount) {
      if (current.isNil || current.offset === 0 && current.length === 0 || current.length < TRANSACTION_ENTRY_LENGTH2 + NEXT_FRAGMENT_LENGTH2) {
        throw new OneNoteFormatError(
          "ONENOTE_TRANSACTION_LOG_TRUNCATED",
          "The transaction log ended before all committed transactions were found.",
          current.offset
        );
      }
      if (++fragmentCount > options.maxTransactionLogFragments) {
        throw new OneNoteFormatError("ONENOTE_TRANSACTION_FRAGMENT_LIMIT", "The transaction-log fragment limit was exceeded.", current.offset);
      }
      if (this.#seen(Tag3.transactionFragment, 0, current.offset)) {
        throw new OneNoteFormatError("ONENOTE_TRANSACTION_FRAGMENT_CYCLE", "The transaction-log fragment chain contains a cycle.", current.offset);
      }
      this.#mark(Tag3.transactionFragment, 0, current.offset);
      if (current.offset > this.#declaredFileLength || current.length > this.#declaredFileLength - current.offset) {
        throw new OneNoteFormatError("ONENOTE_TRANSACTION_FRAGMENT_BOUNDS", "A transaction-log fragment lies outside the declared file length.", current.offset);
      }
      if (current.offset + current.length > this.#window.size) {
        throw new OneNoteFormatError("ONENOTE_TRANSACTION_FRAGMENT_TRUNCATED", "The file ended while reading a transaction-log fragment.", current.offset);
      }
      const entryBytes = Math.floor((current.length - NEXT_FRAGMENT_LENGTH2) / TRANSACTION_ENTRY_LENGTH2) * TRANSACTION_ENTRY_LENGTH2;
      let offset = 0;
      while (offset < entryBytes && completedTransactions < transactionCount) {
        if (++entryCount > options.maxTransactionEntries) {
          throw new OneNoteFormatError("ONENOTE_TRANSACTION_ENTRY_LIMIT", "The transaction-entry limit was exceeded.", current.offset + offset);
        }
        const entry = this.#window.peek(current.offset + offset, TRANSACTION_ENTRY_LENGTH2);
        const sourceId = readUInt322(entry, 0);
        const value = readUInt322(entry, 4);
        const nextCrc = continueCrc2(runningCrc, entry, TRANSACTION_ENTRY_LENGTH2, fileKind);
        if (sourceId === 1) {
          if (options.validateTransactionChecksums && value !== runningCrc) {
            throw new OneNoteFormatError("ONENOTE_TRANSACTION_CHECKSUM", "A committed transaction has an invalid sentinel checksum.", current.offset + offset + 4);
          }
          completedTransactions++;
        } else {
          if (sourceId < 16) {
            throw new OneNoteFormatError("ONENOTE_TRANSACTION_SOURCE_ID", "A transaction entry contains an invalid file-node-list identity.", current.offset + offset);
          }
          if (value > options.maxFileNodes) {
            throw new OneNoteFormatError("ONENOTE_TRANSACTION_FILE_NODE_COUNT", "A transaction entry contains an invalid file-node count.", current.offset + offset + 4);
          }
          const previous = this.#committedNodeCount(sourceId);
          if (previous !== void 0 && value <= previous) {
            throw new OneNoteFormatError("ONENOTE_TRANSACTION_FILE_NODE_SEQUENCE", "A transaction entry does not increase its file-node-list count.", current.offset + offset + 4);
          }
          if (previous === void 0) listCount++;
          this.#index.store.set(
            this.#key.reset(Tag3.transactionCount).u32(sourceId).done(),
            this.#value.reset().u32(value).done()
          );
        }
        runningCrc = nextCrc;
        offset += TRANSACTION_ENTRY_LENGTH2;
      }
      if (completedTransactions >= transactionCount) break;
      current = readNextFragment(this.#window.peek(current.offset + entryBytes, NEXT_FRAGMENT_LENGTH2));
    }
    if (listCount === 0) {
      throw new OneNoteFormatError("ONENOTE_TRANSACTION_LOG_EMPTY", "The committed transaction log declares no file-node lists.");
    }
  }
  #committedNodeCount(listId) {
    const stored = this.#index.store.get(this.#key.reset(Tag3.transactionCount).u32(listId).done());
    return stored ? readUInt322(stored, 0) : void 0;
  }
  // -- File-node lists ----------------------------------------------------
  /**
   * Every committed node of one file-node list, in order, one at a time.
   *
   * The generator is what makes the walk incremental: the caller can descend
   * into a referenced list and come back, and this resumes mid-fragment
   * without the parent's remaining nodes ever having been materialized. The
   * list-wide checks that `readFileNodeList` makes on a finished array — the
   * committed count, an empty chain — run when the generator finishes, so
   * they still fire, but only for a list that was walked to its end.
   */
  *#fileNodes(first) {
    const options = this.#index.options;
    const scope = this.#fragmentScopes++;
    let current = first;
    let listId;
    let committedNodeCount = 0;
    let produced = 0;
    let expectedSequence = 0;
    let fragmentCount = 0;
    while (!current.isNil) {
      if (current.offset === 0 && current.length === 0 || current.length < FRAGMENT_HEADER_LENGTH2 + FRAGMENT_TRAILER_LENGTH2) {
        throw new OneNoteFormatError("ONENOTE_FILE_NODE_FRAGMENT_REFERENCE", "A file-node-list fragment reference is empty or too short.", current.offset);
      }
      if (fragmentCount >= options.maxFileNodeListFragments) {
        throw new OneNoteFormatError("ONENOTE_FILE_NODE_FRAGMENT_LIMIT", "The file-node-list fragment limit was exceeded.", current.offset);
      }
      if (this.#seen(Tag3.listFragment, scope, current.offset)) {
        throw new OneNoteFormatError("ONENOTE_FILE_NODE_FRAGMENT_CYCLE", "The file-node-list fragment chain contains a cycle.", current.offset);
      }
      this.#mark(Tag3.listFragment, scope, current.offset);
      if (current.offset > this.#declaredFileLength || current.length > this.#declaredFileLength - current.offset) {
        throw new OneNoteFormatError("ONENOTE_CHUNK_REFERENCE_BOUNDS", "The file-node-list fragment lies outside the declared file length.", current.offset);
      }
      if (current.offset + current.length > this.#window.size) {
        throw new OneNoteFormatError("ONENOTE_TRUNCATED_STRUCTURE", "The OneNote file ended while reading a referenced structure.", current.offset);
      }
      const head2 = this.#window.peek(current.offset, FRAGMENT_HEADER_LENGTH2);
      if (!bytesMatch(head2, 0, FILE_NODE_LIST_HEADER_MAGIC)) {
        throw new OneNoteFormatError("ONENOTE_FILE_NODE_HEADER_MAGIC", "The file-node-list fragment header magic is invalid.", current.offset);
      }
      const currentListId = readUInt322(head2, 8);
      const sequence = readUInt322(head2, 12);
      if (currentListId < 16) {
        throw new OneNoteFormatError("ONENOTE_FILE_NODE_LIST_ID", "The file-node-list identity is below the minimum valid value.", current.offset + 8);
      }
      if (listId !== void 0 && listId !== currentListId) {
        throw new OneNoteFormatError("ONENOTE_FILE_NODE_LIST_MISMATCH", "A fragment belongs to a different file-node list.", current.offset + 8);
      }
      if (listId === void 0) {
        const count = this.#committedNodeCount(currentListId);
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
      const trailerOffset = current.offset + current.length - FRAGMENT_TRAILER_LENGTH2;
      const trailer = this.#window.read(trailerOffset, FRAGMENT_TRAILER_LENGTH2);
      if (!bytesMatch(trailer, FRAGMENT_TRAILER_LENGTH2 - 8, FILE_NODE_LIST_FOOTER_MAGIC)) {
        throw new OneNoteFormatError("ONENOTE_FILE_NODE_FOOTER_MAGIC", "The file-node-list fragment footer magic is invalid.", current.offset + current.length - 8);
      }
      listId = currentListId;
      fragmentCount++;
      const remaining = committedNodeCount - produced;
      if (remaining <= 0) break;
      let offset = current.offset + FRAGMENT_HEADER_LENGTH2;
      let fromFragment = 0;
      while (trailerOffset - offset >= 4 && fromFragment < remaining) {
        if (produced >= options.maxFileNodes) {
          throw new OneNoteFormatError("ONENOTE_FILE_NODE_LIMIT", "The file-node limit was exceeded.", offset);
        }
        const header = readUInt322(this.#window.peek(offset, 4), 0);
        const id = header & 1023;
        if (id === 0) break;
        const size = header >>> 10 & 8191;
        const stpFormat = header >>> 23 & 3;
        const cbFormat = header >>> 25 & 3;
        const rawBaseType = header >>> 27 & 15;
        if ((header & 2147483648) === 0) {
          throw new OneNoteFormatError("ONENOTE_FILE_NODE_RESERVED_BIT", "The required file-node reserved bit is not set.", offset);
        }
        if (size < 4 || size > trailerOffset - offset) {
          throw new OneNoteFormatError("ONENOTE_FILE_NODE_SIZE", "The file-node size is invalid or crosses the fragment trailer.", offset);
        }
        if (rawBaseType > 2) {
          throw new OneNoteFormatError("ONENOTE_FILE_NODE_BASE_TYPE", "The file-node base type is invalid.", offset);
        }
        const baseType = BASE_TYPES2[rawBaseType];
        const data = this.#window.read(offset + 4, size - 4);
        let chunkReference;
        if (baseType !== "inline") {
          chunkReference = readChunkReference2(data, stpFormat, cbFormat, offset + 4);
          if (isRealChunk(chunkReference) && (chunkReference.offset > this.#declaredFileLength || chunkReference.length > this.#declaredFileLength - chunkReference.offset)) {
            throw new OneNoteFormatError("ONENOTE_CHUNK_REFERENCE_BOUNDS", "The file-node chunk reference lies outside the declared file length.", chunkReference.offset);
          }
        } else if (cbFormat !== 0) {
          throw new OneNoteFormatError("ONENOTE_INLINE_CB_FORMAT", "An inline file node has a nonzero byte-count format.", offset);
        }
        yield { id, baseType, fileOffset: offset, chunkReference, data };
        produced++;
        fromFragment++;
        offset += size;
        if (id === FileNodeId.chunkTerminator) break;
      }
      current = readNextFragment(trailer);
      expectedSequence++;
      if (produced === committedNodeCount) break;
    }
    if (listId === void 0) {
      throw new OneNoteFormatError("ONENOTE_FILE_NODE_LIST_EMPTY", "The file-node list contains no fragments.");
    }
    if (produced !== committedNodeCount) {
      throw new OneNoteFormatError("ONENOTE_FILE_NODE_COUNT", "The file-node list ended before its committed transaction-log count was reached.", first.offset);
    }
  }
  /**
   * The root list may hold only object-space references and one root
   * declaration, which is checked before anything descends into it. The nodes
   * are read a second time by the walk proper; the list is a handful of nodes,
   * and reading it twice is cheaper than keeping it.
   */
  #validateRootList(root) {
    let manifestReferences = 0;
    let rootDeclarations = 0;
    let disallowedAt;
    for (const node of this.#fileNodes(root)) {
      if (node.id === FileNodeId.objectSpaceManifestListReference) manifestReferences++;
      if (node.id === FileNodeId.objectSpaceManifestRoot) rootDeclarations++;
      const allowed = node.id === FileNodeId.objectSpaceManifestListReference || node.id === FileNodeId.objectSpaceManifestRoot || node.id === FileNodeId.chunkTerminator || this.#header.fileKind === "section" && node.id === FileNodeId.fileDataStoreListReference;
      if (!allowed && disallowedAt === void 0) disallowedAt = node.fileOffset;
    }
    if (manifestReferences < 1 || rootDeclarations !== 1) {
      throw new OneNoteFormatError(
        "ONENOTE_ROOT_FILE_NODE_LIST",
        "The root file-node list does not contain the required object-space references and single root declaration."
      );
    }
    if (disallowedAt !== void 0) {
      throw new OneNoteFormatError(
        "ONENOTE_ROOT_FILE_NODE_TYPE",
        "The root file-node list contains a file-node type that is not valid at the root.",
        disallowedAt
      );
    }
  }
  // -- Node dispatch ------------------------------------------------------
  #processNode(node, frame) {
    switch (node.id) {
      case FileNodeId.revisionManifestListStart:
        frame.objectSpaceId = readExtendedGuidAt2(node.data, 0);
        break;
      case FileNodeId.revisionManifestStart4:
      case FileNodeId.revisionManifestStart6:
      case FileNodeId.revisionManifestStart7:
        frame.revisionOrder = this.#readRevisionManifest(node, frame);
        break;
      case FileNodeId.revisionRoleDeclaration:
        this.#readRoleDeclaration(node, frame, false);
        break;
      case FileNodeId.revisionRoleAndContextDeclaration:
        this.#readRoleDeclaration(node, frame, true);
        break;
      case FileNodeId.globalIdTableStart:
      case FileNodeId.globalIdTableStart2:
        frame.scope = this.#index.openGlobalIdScope();
        break;
      case FileNodeId.globalIdTableEntry:
        this.#readGlobalIdEntry(node, frame.scope);
        break;
      case FileNodeId.rootObjectReference2:
      case FileNodeId.rootObjectReference3:
        if (frame.revisionOrder !== NO_REVISION) this.#readRootReference(node, frame);
        break;
      case FileNodeId.objectDeclarationWithRefCount:
      case FileNodeId.objectDeclarationWithRefCount2:
      case FileNodeId.objectDeclaration2RefCount:
      case FileNodeId.objectDeclaration2LargeRefCount:
      case FileNodeId.readOnlyObjectDeclaration2RefCount:
      case FileNodeId.readOnlyObjectDeclaration2LargeRefCount:
      case FileNodeId.objectRevisionWithRefCount:
      case FileNodeId.objectRevisionWithRefCount2:
        this.#readObject(node, frame);
        break;
      case FileNodeId.objectDeclarationFileData3RefCount:
      case FileNodeId.objectDeclarationFileData3LargeRefCount:
        this.#readFileDataDeclaration(node, frame);
        break;
      case FileNodeId.fileDataStoreObjectReference:
        this.#readFileDataStoreObject(node);
        break;
    }
  }
  #readRevisionManifest(node, frame) {
    const id = readExtendedGuidAt2(node.data, 0);
    const dependency = readExtendedGuidAt2(node.data, 20);
    const roleOffset = node.id === FileNodeId.revisionManifestStart4 ? 48 : 40;
    const role = readUInt322(node.data, roleOffset);
    const isEncrypted = readUInt162(node.data, roleOffset + 4) !== 0;
    const contextId = node.id === FileNodeId.revisionManifestStart7 ? readExtendedGuidAt2(node.data, 46) : void 0;
    if (this.#index.hasRevision(id)) {
      throw new OneNoteFormatError("ONENOTE_REVISION_ID", "A revision manifest identifier is duplicated.", node.fileOffset);
    }
    const order = this.#index.addRevision({
      id,
      dependencyId: isEmptyGuid2(dependency) ? void 0 : dependency,
      role,
      isEncrypted,
      contextId,
      objectSpaceId: frame.objectSpaceId
    });
    this.#index.addRoleAssociation(order, { contextId, role, order: this.#nextRoleAssociationOrder++ });
    return order;
  }
  #readRoleDeclaration(node, frame, includesContext) {
    const revisionId = readExtendedGuidAt2(node.data, 0);
    const role = readUInt322(node.data, 20);
    if (role > 65535) {
      throw new OneNoteFormatError("ONENOTE_REVISION_ROLE", "A revision-role label has nonzero reserved high bytes.", node.fileOffset + 20);
    }
    const revision = this.#index.revision(revisionId);
    if (!revision || !frame.objectSpaceId || !revision.objectSpaceId || guidKey(frame.objectSpaceId) !== guidKey(revision.objectSpaceId)) {
      throw new OneNoteFormatError(
        "ONENOTE_REVISION_ROLE_TARGET",
        "A revision-role declaration does not reference a preceding revision in the current object space.",
        node.fileOffset
      );
    }
    let contextId;
    if (includesContext) {
      const context = readExtendedGuidAt2(node.data, 24);
      if (!isEmptyGuid2(context)) contextId = context;
    }
    this.#index.addRoleAssociation(revision.order, { contextId, role, order: this.#nextRoleAssociationOrder++ });
  }
  #readGlobalIdEntry(node, scope) {
    const index = readUInt322(node.data, 0);
    if (index >= 16777215 || this.#index.hasGlobalId(scope, index)) {
      throw new OneNoteFormatError("ONENOTE_GLOBAL_ID_INDEX", "A global-identification table index is invalid or duplicated.", node.fileOffset);
    }
    const identifier = readGuid(node.data, 4);
    if (identifier === EMPTY_GUID) {
      throw new OneNoteFormatError("ONENOTE_GLOBAL_ID_GUID", "A global-identification table contains an empty GUID.", node.fileOffset + 4);
    }
    this.#index.addGlobalId(scope, index, identifier);
  }
  #resolveCompactId(data, offset, scope, absoluteOffset) {
    const compact = readUInt322(data, offset);
    const identifier = this.#index.globalId(scope, compact >>> 8);
    if (identifier === void 0) {
      throw new OneNoteFormatError("ONENOTE_COMPACT_ID", "A CompactID references a missing global-identification table entry.", absoluteOffset);
    }
    return { identifier, value: compact & 255 };
  }
  #readRootReference(node, frame) {
    const isExtended = node.id === FileNodeId.rootObjectReference3;
    const objectId = isExtended ? readExtendedGuidAt2(node.data, 0) : this.#resolveCompactId(node.data, 0, frame.scope, node.fileOffset);
    this.#index.addRootObject(frame.revisionOrder, {
      objectId,
      role: readUInt322(node.data, isExtended ? 20 : 4)
    });
  }
  #readObject(node, frame) {
    if (this.#index.objectCount >= this.#index.options.maxObjects) {
      throw new OneNoteFormatError("ONENOTE_OBJECT_LIMIT", "The object declaration limit was exceeded.", node.fileOffset);
    }
    if (!isRealChunk(node.chunkReference)) {
      throw new OneNoteFormatError("ONENOTE_OBJECT_REFERENCE", "An object declaration does not reference object data.", node.fileOffset);
    }
    const bodyOffset = node.chunkReference.encodedLength;
    const id = this.#resolveCompactId(node.data, bodyOffset, frame.scope, node.fileOffset + bodyOffset);
    const isRevision = node.id === FileNodeId.objectRevisionWithRefCount || node.id === FileNodeId.objectRevisionWithRefCount2;
    let jcid;
    let referenceCount;
    if (node.id === FileNodeId.objectDeclarationWithRefCount || node.id === FileNodeId.objectDeclarationWithRefCount2) {
      jcid = 131073;
      const countOffset = bodyOffset + 10;
      referenceCount = node.id === FileNodeId.objectDeclarationWithRefCount ? readByte2(node.data, countOffset) : readUInt322(node.data, countOffset);
    } else if (isRevision) {
      jcid = this.#knownJcid(id) ?? 0;
      const flagsOffset = bodyOffset + 4;
      referenceCount = node.id === FileNodeId.objectRevisionWithRefCount ? readByte2(node.data, flagsOffset) >> 2 : readUInt322(node.data, flagsOffset + 4);
    } else {
      jcid = readUInt322(node.data, bodyOffset + 4);
      const countOffset = bodyOffset + 9;
      const large = node.id === FileNodeId.objectDeclaration2LargeRefCount || node.id === FileNodeId.readOnlyObjectDeclaration2LargeRefCount;
      referenceCount = large ? readUInt322(node.data, countOffset) : readByte2(node.data, countOffset);
    }
    const revision = frame.revisionOrder === NO_REVISION ? void 0 : this.#index.revisionAt(frame.revisionOrder);
    const propertySet = revision?.isEncrypted ? void 0 : this.#referencedRange(node.chunkReference, 0, node.chunkReference.length, "object property set");
    this.#index.addObject({
      id,
      jcid,
      referenceCount,
      revisionOrder: frame.revisionOrder,
      revisionId: revision?.id,
      isRevision,
      propertySet,
      globalIdScope: frame.scope
    });
    if (jcid !== 0) {
      this.#index.store.set(
        this.#key.reset(Tag3.knownJcid).extendedGuid(id).done(),
        this.#value.reset().u32(jcid).done()
      );
    }
  }
  #knownJcid(id) {
    const stored = this.#index.store.get(this.#key.reset(Tag3.knownJcid).extendedGuid(id).done());
    return stored ? readUInt322(stored, 0) : void 0;
  }
  #readFileDataDeclaration(node, frame) {
    if (this.#index.objectCount >= this.#index.options.maxObjects) {
      throw new OneNoteFormatError("ONENOTE_OBJECT_LIMIT", "The object declaration limit was exceeded.", node.fileOffset);
    }
    const id = this.#resolveCompactId(node.data, 0, frame.scope, node.fileOffset);
    const jcid = readUInt322(node.data, 4);
    const large = node.id === FileNodeId.objectDeclarationFileData3LargeRefCount;
    const referenceCount = large ? readUInt322(node.data, 8) : readByte2(node.data, 8);
    const reference = readStorageString2(node.data, large ? 12 : 9, node.fileOffset);
    const extension = readStorageString2(node.data, reference.next, node.fileOffset);
    const revision = frame.revisionOrder === NO_REVISION ? void 0 : this.#index.revisionAt(frame.revisionOrder);
    this.#index.addObject({
      id,
      jcid,
      referenceCount,
      revisionOrder: frame.revisionOrder,
      revisionId: revision?.id,
      isRevision: false,
      fileDataReference: reference.value,
      fileExtension: extension.value,
      globalIdScope: frame.scope
    });
    this.#index.store.set(
      this.#key.reset(Tag3.knownJcid).extendedGuid(id).done(),
      this.#value.reset().u32(jcid).done()
    );
  }
  /**
   * A FileDataStoreObject's framing is checked here and its payload is not
   * touched: the asset caps are enforced against the declared length, so a
   * 60 MiB attachment costs nothing until something asks to write it.
   */
  #readFileDataStoreObject(node) {
    if (!isRealChunk(node.chunkReference)) return;
    const reference = node.chunkReference;
    const referenceId = readGuid(node.data, reference.encodedLength);
    if (reference.length < 52) {
      throw new OneNoteFormatError("ONENOTE_FILE_DATA_LENGTH", "A FileDataStoreObject is shorter than its required framing.", reference.offset);
    }
    const headerRange = this.#referencedRange(reference, 0, 36, "file-data store object header");
    const header = this.#window.read(headerRange.offset, headerRange.length);
    const length = readUInt64(header, 16);
    if (length > reference.length - 52) {
      throw new OneNoteFormatError("ONENOTE_FILE_DATA_LENGTH", "A FileDataStoreObject payload length exceeds its containing frame.", reference.offset + 16);
    }
    if (length > this.#index.options.maxAssetBytes || this.#totalAssetBytes > this.#index.options.maxTotalAssetBytes - length) {
      throw new OneNoteFormatError("ONENOTE_ASSET_LIMIT", "An embedded OneNote asset exceeds the configured materialization limits.", node.fileOffset);
    }
    const footerRange = this.#referencedRange(reference, reference.length - 16, 16, "file-data store object footer");
    const footer = this.#window.peek(footerRange.offset, footerRange.length);
    if (readGuid(header, 0) !== FILE_DATA_HEADER2 || readGuid(footer, 0) !== FILE_DATA_FOOTER2) {
      throw new OneNoteFormatError("ONENOTE_FILE_DATA_FRAMING", "A FileDataStoreObject has invalid framing GUIDs.", reference.offset);
    }
    const payload = this.#referencedRange(reference, 36, length, "file-data store object payload");
    this.#totalAssetBytes += length;
    this.#index.addFileData(referenceId, payload);
  }
  #referencedRange(reference, relativeOffset, length, name) {
    if (reference.offset > this.#declaredFileLength || reference.length > this.#declaredFileLength - reference.offset) {
      throw new OneNoteFormatError("ONENOTE_CHUNK_REFERENCE_BOUNDS", `The ${name} lies outside the declared file length.`, reference.offset);
    }
    if (length < 0 || relativeOffset > reference.length || length > reference.length - relativeOffset) {
      throw new OneNoteFormatError("ONENOTE_CHUNK_REFERENCE_BOUNDS", `The ${name} lies outside its containing chunk reference.`, reference.offset);
    }
    const offset = reference.offset + relativeOffset;
    if (offset + length > this.#window.size) {
      throw new OneNoteFormatError("ONENOTE_TRUNCATED_STRUCTURE", `The file ended while reading ${name}.`, offset);
    }
    return { offset, length };
  }
  // -- Disk-backed sets ---------------------------------------------------
  #seen(tag, scope, offset) {
    return this.#index.store.has(this.#key.reset(tag).u32(scope).big(offset).done());
  }
  #mark(tag, scope, offset) {
    this.#index.store.set(this.#key.reset(tag).u32(scope).big(offset).done(), EMPTY_VALUE2);
  }
  #visitedList(offset) {
    return this.#seen(Tag3.visitedList, 0, offset);
  }
  #markVisitedList(offset) {
    this.#mark(Tag3.visitedList, 0, offset);
  }
};
function readNextFragment(data) {
  const length = readUInt322(data, 8);
  if (isAllOnes(data, 0, 8) && length === 0) return { offset: 0, length: 0, isNil: true };
  return { offset: readUInt64(data, 0), length, isNil: false };
}
function indexRevisionStore(header, window, options = {}) {
  if (header.expectedFileLength === void 0 || !header.rootFileNodeList) {
    throw new OneNoteFormatError(
      "ONENOTE_REVISION_STORE_HEADER",
      "The revision-store header does not expose its required root structures."
    );
  }
  const index = new IndexedSection("revision-store", header, window, options);
  try {
    new RevisionStoreIndexer(index).run();
  } catch (error) {
    index.close();
    throw error;
  }
  return index;
}

// src/indexing/index-section.ts
function readSectionHeader(window, options = DEFAULT_READER_OPTIONS) {
  const span = Math.min(REVISION_STORE_HEADER_LENGTH, window.size);
  return readFileHeader(window.read(0, span), window.size, options);
}
function indexSection(source, options = {}) {
  const window = new ByteWindow(source, options.windowBytes ?? DEFAULT_SECTION_INDEX_OPTIONS.windowBytes);
  const header = readSectionHeader(window, options.reader ?? DEFAULT_READER_OPTIONS);
  switch (header.storageFormat) {
    case "revision-store":
      return indexRevisionStore(header, window, options);
    case "file-synchronization-package":
      return indexPackage(header, window, options);
    default:
      throw new OneNoteFormatError(
        "ONENOTE_NOT_A_SECTION",
        "Bounded-memory indexing reads a loose .one section; this artifact is neither a desktop revision store nor a packaged one."
      );
  }
}

// src/resolve/property-view.ts
var ReferenceKind = {
  object: 0,
  objectSpace: 1,
  context: 2
};
var Tag4 = {
  /** One record per object whose set has been walked. */
  parsed: 1,
  /** One record per set, per property identifier held in it. */
  property: 2
};
var PropertyStore = class {
  window;
  store;
  options;
  /** Namespace inside the store, so a caller can host several of these. */
  tagBase;
  #key = new RecordWriter(32);
  #value = new RecordWriter(96);
  #slots = 0;
  constructor(window, store, options, tagBase) {
    this.window = window;
    this.store = store;
    this.options = options;
    this.tagBase = tagBase;
  }
  /**
   * The set an object's data holds, walked at most once per object.
   *
   * `key` identifies the object for caching. Two objects that share a key
   * would share a walk, so it has to be the object's index order, which is
   * unique within a section.
   */
  viewOf(key, value, ids) {
    const cached = this.store.get(this.#key.reset(this.tagBase + Tag4.parsed).u32(key).done());
    if (cached) {
      const reader = new RecordReader(cached);
      const slot2 = reader.u32();
      return new PropertySetView(this, slot2, value, ids, {
        object: reader.range(),
        objectSpace: reader.optionalRange(),
        context: reader.optionalRange(),
        rootOffset: reader.u32()
      });
    }
    const slot = this.#slots++;
    const streams = this.#readStreams(value);
    const view = new PropertySetView(this, slot, value, ids, streams);
    this.#walk(slot, value, streams, streams.rootOffset, { object: 0, objectSpace: 0, context: 0 }, 0);
    this.store.set(
      this.#key.reset(this.tagBase + Tag4.parsed).u32(key).done(),
      this.#value.reset().u32(slot).range(streams.object).optionalRange(streams.objectSpace).optionalRange(streams.context).u32(streams.rootOffset).done()
    );
    return view;
  }
  /**
   * A nested set, walked into a slot of its own.
   *
   * These are not cached: a nested set is reached through the property that
   * holds it, is read once where it is used, and there are at most a handful
   * per object. Giving each a fresh slot costs a few records rather than the
   * bookkeeping that reusing one would need to stay correct.
   */
  childView(parent, property, position) {
    const slot = this.#slots++;
    const counters = {
      object: property.childCounters[0],
      objectSpace: property.childCounters[1],
      context: property.childCounters[2]
    };
    let offset = property.childOffset;
    for (let index = 0; index < position; index++) {
      offset = this.#walk(void 0, parent.value, parent.streams, offset, counters, 1);
    }
    this.#walk(slot, parent.value, parent.streams, offset, counters, 1);
    return new PropertySetView(this, slot, parent.value, parent.ids, parent.streams);
  }
  /** @internal */
  lookup(slot, propertyId) {
    const stored = this.store.get(
      this.#key.reset(this.tagBase + Tag4.property).u32(slot).u32(propertyId & 2147483647).done()
    );
    if (!stored) return void 0;
    const reader = new RecordReader(stored);
    const property = { rawId: reader.u32(), index: reader.u32(), type: reader.u8() };
    if (reader.flag()) property.booleanValue = reader.flag();
    if (reader.flag()) property.scalarValue = reader.big();
    property.data = reader.optionalRange();
    if (reader.flag()) {
      property.referenceKind = reader.u8();
      property.referenceStart = reader.u32();
      property.referenceCount = reader.u32();
    }
    if (reader.flag()) {
      property.childCount = reader.u32();
      property.childOffset = reader.u32();
      property.childCounters = [reader.u32(), reader.u32(), reader.u32()];
    }
    return property;
  }
  #error(value, offset, code, message) {
    return new OneNoteFormatError(code, message, value.offset + offset);
  }
  #readStreams(value) {
    const reader = new RangeReader(this.window, value);
    let offset = 0;
    const object = this.#readStream(reader, value, offset);
    offset = object.range.length + 4;
    let objectSpace;
    let context;
    if (!object.osidStreamNotPresent) {
      const osids = this.#readStream(reader, value, offset);
      objectSpace = osids.range;
      offset += osids.range.length + 4;
      if (osids.extendedStreamsPresent) {
        const contexts = this.#readStream(reader, value, offset);
        context = contexts.range;
        offset += contexts.range.length + 4;
      }
    }
    return { object: object.range, objectSpace, context, rootOffset: offset };
  }
  #readStream(reader, value, offset) {
    this.#ensure(value, offset, 4);
    const header = reader.u32(offset);
    const count = header & 16777215;
    if ((header & 1056964608) !== 0 || count > this.options.maxObjects) {
      throw this.#error(
        value,
        offset,
        "ONENOTE_OBJECT_STREAM_HEADER",
        "An object-reference stream header is invalid or exceeds the object limit."
      );
    }
    this.#ensure(value, offset + 4, count * 4);
    return {
      range: { offset: value.offset + offset + 4, length: count * 4 },
      extendedStreamsPresent: (header & 1073741824) !== 0,
      osidStreamNotPresent: (header & 2147483648) !== 0
    };
  }
  #ensure(value, offset, length) {
    if (length < 0 || offset > value.length - length) {
      throw this.#error(
        value,
        offset,
        "ONENOTE_TRUNCATED_PROPERTY_SET",
        "The object data ended inside a property set."
      );
    }
  }
  /**
   * Walk one set, recording a descriptor per property.
   *
   * This mirrors `Cursor.readPropertySet` case for case. What differs is that
   * a value is skipped over rather than copied, and an identifier run is
   * recorded as a position and a count rather than taken out of an array —
   * the two places where the original's cost is proportional to the content.
   */
  #walk(slot, value, streams, start, counters, depth) {
    if (depth >= this.options.maxPropertySetDepth) {
      throw this.#error(
        value,
        start,
        "ONENOTE_PROPERTY_DEPTH",
        "The nested property-set depth limit was exceeded."
      );
    }
    const reader = new RangeReader(this.window, value);
    let offset = start;
    this.#ensure(value, offset, 2);
    const count = reader.u16(offset);
    offset += 2;
    if (count > this.options.maxPropertiesPerObject) {
      throw this.#error(
        value,
        offset,
        "ONENOTE_PROPERTY_LIMIT",
        "The property count exceeds the configured per-object limit."
      );
    }
    const idsOffset = offset;
    this.#ensure(value, idsOffset, count * 4);
    offset += count * 4;
    for (let index = 0; index < count; index++) {
      const rawId = reader.u32(idsOffset + index * 4);
      const type = rawId >>> 26 & 31;
      const property = { rawId, index, type };
      switch (type) {
        case 1:
          break;
        case 2:
          property.booleanValue = (rawId & 2147483648) !== 0;
          break;
        case 3:
          offset = this.#scalar(reader, value, property, offset, 1);
          break;
        case 4:
          offset = this.#scalar(reader, value, property, offset, 2);
          break;
        case 5:
          offset = this.#scalar(reader, value, property, offset, 4);
          break;
        case 6:
          offset = this.#scalar(reader, value, property, offset, 8);
          break;
        case 7: {
          this.#ensure(value, offset, 4);
          const length = reader.u32(offset);
          offset += 4;
          if (length >= 1073741824) {
            throw this.#error(
              value,
              offset,
              "ONENOTE_PROPERTY_DATA_LENGTH",
              "A length-prefixed property value is too large."
            );
          }
          this.#ensure(value, offset, length);
          property.data = { offset: value.offset + offset, length };
          offset += length;
          break;
        }
        case 8:
          this.#take(property, streams, counters, ReferenceKind.object, 1, value, offset);
          break;
        case 9: {
          const taken = this.#referenceCount(reader, value, offset);
          offset = taken.offset;
          this.#take(property, streams, counters, ReferenceKind.object, taken.count, value, offset);
          break;
        }
        case 10:
          this.#take(property, streams, counters, ReferenceKind.objectSpace, 1, value, offset);
          break;
        case 11: {
          const taken = this.#referenceCount(reader, value, offset);
          offset = taken.offset;
          this.#take(property, streams, counters, ReferenceKind.objectSpace, taken.count, value, offset);
          break;
        }
        case 12:
          this.#take(property, streams, counters, ReferenceKind.context, 1, value, offset);
          break;
        case 13: {
          const taken = this.#referenceCount(reader, value, offset);
          offset = taken.offset;
          this.#take(property, streams, counters, ReferenceKind.context, taken.count, value, offset);
          break;
        }
        case 16: {
          const taken = this.#referenceCount(reader, value, offset);
          offset = taken.offset;
          if (taken.count === 0) {
            property.childCount = 0;
            property.childOffset = offset;
            property.childCounters = [counters.object, counters.objectSpace, counters.context];
            break;
          }
          this.#ensure(value, offset, 4);
          const childPropertyId = reader.u32(offset);
          offset += 4;
          if ((childPropertyId >>> 26 & 31) !== 17) {
            throw this.#error(
              value,
              offset,
              "ONENOTE_PROPERTY_ARRAY_TYPE",
              "A property-set array does not declare PropertySet element values."
            );
          }
          property.childCount = taken.count;
          property.childOffset = offset;
          property.childCounters = [counters.object, counters.objectSpace, counters.context];
          for (let child = 0; child < taken.count; child++) {
            offset = this.#walk(void 0, value, streams, offset, counters, depth + 1);
          }
          break;
        }
        case 17:
          property.childCount = 1;
          property.childOffset = offset;
          property.childCounters = [counters.object, counters.objectSpace, counters.context];
          offset = this.#walk(void 0, value, streams, offset, counters, depth + 1);
          break;
        default:
          throw this.#error(
            value,
            offset,
            "ONENOTE_PROPERTY_TYPE",
            `The property set contains an unsupported representation type 0x${type.toString(16).padStart(2, "0")}.`
          );
      }
      if (slot !== void 0) this.#record(slot, property);
    }
    return offset;
  }
  #scalar(reader, value, property, offset, byteCount) {
    this.#ensure(value, offset, byteCount);
    const bytes = reader.slice(offset, byteCount);
    let scalar3 = 0;
    let exact = true;
    for (let index = bytes.length - 1; index >= 0; index--) {
      if (scalar3 > Number.MAX_SAFE_INTEGER / 256) exact = false;
      scalar3 = scalar3 * 256 + bytes[index];
    }
    if (exact) property.scalarValue = scalar3;
    property.data = { offset: value.offset + offset, length: byteCount };
    return offset + byteCount;
  }
  #referenceCount(reader, value, offset) {
    this.#ensure(value, offset, 4);
    const count = reader.u32(offset);
    if (count > this.options.maxObjects) {
      throw this.#error(
        value,
        offset,
        "ONENOTE_REFERENCE_COUNT",
        "A property reference count exceeds the configured object limit."
      );
    }
    return { count, offset: offset + 4 };
  }
  #take(property, streams, counters, kind, count, value, offset) {
    const names = ["object", "object-space", "context"];
    const fields = ["object", "objectSpace", "context"];
    const field = fields[kind];
    const stream = streams[field];
    const available = stream ? stream.length >>> 2 : 0;
    const start = counters[field];
    if (count < 0 || start > available - count) {
      throw this.#error(
        value,
        offset,
        "ONENOTE_REFERENCE_STREAM",
        `A property consumes more ${names[kind]} identifiers than its object stream contains.`
      );
    }
    property.referenceKind = kind;
    property.referenceStart = start;
    property.referenceCount = count;
    counters[field] = start + count;
  }
  #record(slot, property) {
    this.#value.reset().u32(property.rawId).u32(property.index).u8(property.type);
    if (property.booleanValue === void 0) this.#value.flag(false);
    else this.#value.flag(true).flag(property.booleanValue);
    this.#value.optionalBig(property.scalarValue);
    this.#value.optionalRange(property.data);
    if (property.referenceKind === void 0) this.#value.flag(false);
    else {
      this.#value.flag(true).u8(property.referenceKind).u32(property.referenceStart).u32(property.referenceCount);
    }
    if (property.childCount === void 0) this.#value.flag(false);
    else {
      this.#value.flag(true).u32(property.childCount).u32(property.childOffset).u32(property.childCounters[0]).u32(property.childCounters[1]).u32(property.childCounters[2]);
    }
    this.store.set(
      this.#key.reset(this.tagBase + Tag4.property).u32(slot).u32(property.rawId & 2147483647).done(),
      this.#value.done()
    );
  }
};
var PropertySetView = class {
  slot;
  /** The object data this set lives in, which every offset is relative to. */
  value;
  ids;
  /** @internal */
  streams;
  #owner;
  constructor(owner, slot, value, ids, streams) {
    this.#owner = owner;
    this.slot = slot;
    this.value = value;
    this.ids = ids;
    this.streams = streams;
  }
  get window() {
    return this.#owner.window;
  }
  find(propertyId) {
    return this.#owner.lookup(this.slot, propertyId);
  }
  /** A nested set held by a property-set or property-set-array value. */
  childAt(property, position) {
    return this.#owner.childView(this, property, position);
  }
  /**
   * The identifiers a property names, resolved one at a time.
   *
   * The CompactIDs are read from the stream at a computed offset, so this
   * costs four bytes per identifier however long the stream is.
   */
  *references(property) {
    for (let index = 0; index < (property?.referenceCount ?? 0); index++) {
      yield this.referenceAt(property, index);
    }
  }
  /**
   * The nth identifier a property names.
   *
   * Positional, because a caller that wants the fifth text run's formatting
   * should not have to build the first four to get at it — and because a walk
   * that indexes rather than iterates never holds a level's children.
   */
  referenceAt(property, index) {
    if (!property?.referenceCount || index < 0 || index >= property.referenceCount) return void 0;
    const field = ["object", "objectSpace", "context"][property.referenceKind];
    const stream = this.streams[field];
    const at = (property.referenceStart + index) * 4;
    const compact = new RangeReader(this.window, stream).u32(at);
    const identifier = this.ids.identifier(compact >>> 8);
    if (identifier === void 0) {
      throw new OneNoteFormatError(
        "ONENOTE_COMPACT_ID",
        "A property reference uses a missing global-identification table entry.",
        stream.offset + at
      );
    }
    return { identifier, value: compact & 255 };
  }
};

// src/resolve/space.ts
var NIL_GUID2 = "00000000-0000-0000-0000-000000000000";
var DEFAULT_CONTEXT_GUID2 = "84defab9-aaa3-4a0d-a3a8-520c77ac7073";
function isNilGuid(id) {
  return id.identifier === NIL_GUID2 && id.value === 0;
}
function isDefaultContext2(id) {
  return isNilGuid(id) || id.identifier === DEFAULT_CONTEXT_GUID2 && id.value === 1;
}
var EMPTY = new Uint8Array(0);
var Tag5 = {
  /** Revision orders sharing one identifier, and how many there are. */
  revisionByGuid: 10,
  revisionByGuidCount: 11,
  /** Distinct object spaces in first-appearance order. */
  spaceOrdinal: 12,
  spaceByOrdinal: 13,
  /** Revision orders belonging to one space, and how many. */
  spaceRevision: 14,
  spaceRevisionCount: 15,
  /** A packaged revision's derived cell and context. */
  cell: 16,
  cellVisited: 24,
  cellAssociation: 25,
  cellAssociationCount: 26,
  /** Slot allocated to a resolved space, by space key. */
  slot: 17,
  /** Inside a slot: the replayed object map, the roots, the chain. */
  slotObject: 18,
  slotRoot: 19,
  slotChain: 20,
  slotVisited: 21,
  /** Cached CompactID pairs for one packaged object. */
  packagedIds: 22,
  packagedIdsBuilt: 23
};
function spaceKey2(id, contextId) {
  return `${indexedGuidKey(id)}|${contextId ? indexedGuidKey(contextId) : "default"}`;
}
var ResolvedSpace = class {
  slot;
  currentRevision;
  #owner;
  constructor(owner, slot, currentRevision) {
    this.#owner = owner;
    this.slot = slot;
    this.currentRevision = currentRevision;
  }
  object(id) {
    return this.#owner.objectInSlot(this.slot, id);
  }
  root(role) {
    return this.#owner.rootInSlot(this.slot, role);
  }
  /** The property set of an object in this space, or nothing if it has none. */
  properties(object) {
    return object && this.#owner.propertiesOf(object);
  }
  /** The set of the object an identifier names, in one step. */
  propertiesOf(id) {
    return this.properties(this.object(id));
  }
};
var SpaceResolver = class {
  index;
  window;
  store;
  properties;
  #key = new RecordWriter(48);
  #value = new RecordWriter(64);
  /**
   * Writers used only by `#bump`.
   *
   * `RecordWriter.done()` hands back a view that the next `reset()` on the
   * same writer invalidates. A counter's key has to stay valid while the
   * record it counts is written, so it cannot come from the writer that
   * record uses.
   */
  #counterKey = new RecordWriter(48);
  #counterValue = new RecordWriter(8);
  #packaged;
  #spaces = 0;
  #slots = 0;
  constructor(index, window, store, propertyTagBase) {
    this.index = index;
    this.window = window;
    this.store = store;
    this.properties = new PropertyStore(window, store, index.options, propertyTagBase);
    this.#packaged = index.encoding === "file-synchronization-package" ? index : void 0;
    this.#groupRevisions();
    if (this.#packaged) this.#assignCells(this.#packaged);
    this.#collectSpaces();
  }
  /** How many distinct object spaces the section holds. */
  get spaceCount() {
    return this.#spaces;
  }
  // -- Construction -------------------------------------------------------
  /**
   * Group revision orders by identifier.
   *
   * Two revisions can carry the same identifier, and the eager reader treats
   * that as one revision for the purpose of what it declares while following
   * dependencies through the last of them. Keeping every order under its
   * identifier is what lets both of those hold here too.
   */
  #groupRevisions() {
    for (const revision of this.index.revisions()) {
      const count = this.#bump((writer) => writer.reset(Tag5.revisionByGuidCount).extendedGuid(revision.id));
      this.store.set(
        this.#key.reset(Tag5.revisionByGuid).extendedGuid(revision.id).u32(count).done(),
        this.#value.reset().u32(revision.order).done()
      );
    }
  }
  /**
   * Give every packaged revision the cell it belongs to.
   *
   * This is `assignCell` from the object-graph builder, following the same
   * chain in the same order so that the association orders — which decide
   * which revision is current for a space — come out the same. Only the head
   * of a chain is current; the rest are its history.
   */
  #assignCells(index) {
    let order = 0;
    for (let position = 0; position < index.cellMappingCount; position++) {
      const mapping = index.cellMappingAt(position);
      const currentRevision = index.cellManifest(mapping.id);
      if (!currentRevision) continue;
      const head2 = this.#revisionElementFor(index, currentRevision);
      if (head2 === void 0) continue;
      const contextId = isDefaultContext2(mapping.cell.first) ? void 0 : mapping.cell.first;
      let revision = head2;
      let isCurrent = true;
      while (revision !== void 0) {
        const visited = this.#key.reset(Tag5.cellVisited).u32(position).u32(revision).done();
        if (this.store.has(visited)) break;
        this.store.set(visited, EMPTY);
        const descriptor = this.index.revisionAt(revision);
        this.store.set(
          this.#key.reset(Tag5.cell).u32(revision).done(),
          this.#value.reset().extendedGuid(mapping.cell.first).extendedGuid(mapping.cell.second).optionalExtendedGuid(contextId).done()
        );
        if (isCurrent) {
          const at = revision;
          const count = this.#bump((writer) => writer.reset(Tag5.cellAssociationCount).u32(at));
          this.store.set(
            this.#key.reset(Tag5.cellAssociation).u32(at).u32(count).done(),
            this.#value.reset().optionalExtendedGuid(contextId).u32(1).u32(order).done()
          );
          isCurrent = false;
        }
        const dependency = descriptor.dependencyId;
        revision = dependency ? this.#lastRevisionFor(dependency) : void 0;
      }
      order++;
    }
  }
  /** Which revision the storage index maps a revision identifier to. */
  #revisionElementFor(index, revisionId) {
    for (let position = 0; position < index.revisionMappingCount; position++) {
      const mapping = index.revisionMappingAt(position);
      if (indexedGuidKey(mapping.revision) !== indexedGuidKey(revisionId)) continue;
      return index.revisionOfElement(mapping.id);
    }
    return void 0;
  }
  /**
   * Enumerate object spaces in the order the eager reader meets them.
   *
   * `findCurrentSpaceByRootJcid` takes the first space whose root is a
   * section node, so this order is part of the output: it decides which space
   * a section with more than one candidate converts from.
   */
  #collectSpaces() {
    for (const revision of this.index.revisions()) {
      const placement = this.#placementOf(revision.order);
      if (!placement.objectSpaceId) continue;
      const spaceGuid = placement.objectSpaceId;
      let ordinal = this.#number(this.#key.reset(Tag5.spaceOrdinal).extendedGuid(spaceGuid).done());
      if (ordinal === void 0) {
        ordinal = this.#spaces++;
        this.store.set(
          this.#key.reset(Tag5.spaceByOrdinal).u32(ordinal).done(),
          this.#value.reset().extendedGuid(spaceGuid).done()
        );
        this.store.set(
          this.#key.reset(Tag5.spaceOrdinal).extendedGuid(spaceGuid).done(),
          this.#value.reset().u32(ordinal).done()
        );
      }
      const at = ordinal;
      const count = this.#bump((writer) => writer.reset(Tag5.spaceRevisionCount).u32(at));
      this.store.set(
        this.#key.reset(Tag5.spaceRevision).u32(at).u32(count).done(),
        this.#value.reset().u32(revision.order).done()
      );
    }
  }
  // -- Placement ----------------------------------------------------------
  /** Where a revision sits: its space, its context, and whether it is current. */
  #placementOf(revision) {
    const descriptor = this.index.revisionAt(revision);
    if (!this.#packaged) {
      return {
        objectSpaceId: descriptor.objectSpaceId,
        contextId: descriptor.contextId,
        role: descriptor.role,
        isEncrypted: descriptor.isEncrypted
      };
    }
    const stored = this.store.get(this.#key.reset(Tag5.cell).u32(revision).done());
    if (!stored) return { role: 0, isEncrypted: false };
    const reader = new RecordReader(stored);
    reader.extendedGuid();
    const objectSpaceId = reader.extendedGuid();
    const contextId = reader.optionalExtendedGuid();
    const current = (this.#number(this.#key.reset(Tag5.cellAssociationCount).u32(revision).done()) ?? 0) > 0;
    return { objectSpaceId, contextId, role: current ? 1 : 0, isEncrypted: false };
  }
  /** The cell a packaged revision belongs to, which its CompactIDs need. */
  cellOf(revision) {
    const stored = this.store.get(this.#key.reset(Tag5.cell).u32(revision).done());
    if (!stored) return void 0;
    const reader = new RecordReader(stored);
    return { first: reader.extendedGuid(), second: reader.extendedGuid() };
  }
  *#associationsOf(revision) {
    if (!this.#packaged) {
      yield* this.index.roleAssociationsOf(revision);
      return;
    }
    const count = this.#number(this.#key.reset(Tag5.cellAssociationCount).u32(revision).done()) ?? 0;
    for (let position = 0; position < count; position++) {
      const stored = this.store.get(
        this.#key.reset(Tag5.cellAssociation).u32(revision).u32(position).done()
      );
      const reader = new RecordReader(stored);
      yield { contextId: reader.optionalExtendedGuid(), role: reader.u32(), order: reader.u32() };
    }
  }
  // -- Resolution ---------------------------------------------------------
  /**
   * The first space whose primary root is an object of the given type.
   *
   * The header cell's own space is skipped, as the eager reader skips it: it
   * describes the file rather than holding any of its content.
   */
  currentSpaceByRootJcid(jcid) {
    for (let ordinal = 0; ordinal < this.#spaces; ordinal++) {
      const spaceGuid = this.#spaceAt(ordinal);
      if (spaceGuid.identifier === HEADER_CELL_OBJECT_SPACE_ID && spaceGuid.value === 1) continue;
      const space = this.tryGetSpace(spaceGuid);
      if (space?.root(1)?.jcid === jcid) return space;
    }
    return void 0;
  }
  tryGetSpace(id, contextId) {
    const key = spaceKey2(id, contextId);
    const cached = this.store.get(this.#key.reset(Tag5.slot).text(key).done());
    if (cached) {
      const reader = new RecordReader(cached);
      const slot = reader.i32();
      return slot < 0 ? void 0 : new ResolvedSpace(this, slot, reader.u32());
    }
    const resolved = this.#resolve(id, contextId);
    this.store.set(
      this.#key.reset(Tag5.slot).text(key).done(),
      this.#value.reset().i32(resolved ? resolved.slot : -1).u32(resolved ? resolved.currentRevision : 0).done()
    );
    return resolved;
  }
  #resolve(id, contextId) {
    const ordinal = this.#number(this.#key.reset(Tag5.spaceOrdinal).extendedGuid(id).done());
    if (ordinal === void 0) return void 0;
    const count = this.#number(this.#key.reset(Tag5.spaceRevisionCount).u32(ordinal).done()) ?? 0;
    let current;
    let bestOrder = -1;
    for (let position = 0; position < count; position++) {
      const revision = this.#number(
        this.#key.reset(Tag5.spaceRevision).u32(ordinal).u32(position).done()
      );
      if (this.#placementOf(revision).isEncrypted) continue;
      for (const association of this.#associationsOf(revision)) {
        if (association.role !== 1) continue;
        if (!contextEquals2(association.contextId, contextId)) continue;
        if (association.order >= bestOrder) {
          bestOrder = association.order;
          current = revision;
        }
      }
    }
    if (current === void 0) return void 0;
    const slot = this.#slots++;
    this.#replay(slot, current);
    return new ResolvedSpace(this, slot, current);
  }
  /**
   * Apply a revision chain into a slot, oldest revision first.
   *
   * The chain is walked newest-first because that is the direction the
   * dependency links point, recorded as it goes, and then applied in reverse
   * — so a declaration in a later revision replaces the one it revises, which
   * is what makes the newest state the one a lookup finds.
   */
  #replay(slot, current) {
    let depth = 0;
    let revision = current;
    while (revision !== void 0) {
      const id = this.index.revisionAt(revision).id;
      const visited = this.#key.reset(Tag5.slotVisited).u32(slot).extendedGuid(id).done();
      if (this.store.has(visited)) break;
      this.store.set(visited, this.#value.reset().u32(depth).done());
      this.store.set(
        this.#key.reset(Tag5.slotChain).u32(slot).u32(depth++).done(),
        this.#value.reset().u32(revision).done()
      );
      const dependency = this.index.revisionAt(revision).dependencyId;
      revision = dependency ? this.#lastRevisionFor(dependency) : void 0;
    }
    for (let position = depth - 1; position >= 0; position--) {
      const chained = this.#number(this.#key.reset(Tag5.slotChain).u32(slot).u32(position).done());
      const id = this.index.revisionAt(chained).id;
      for (const order of this.#ordersFor(id)) {
        for (const object of this.index.objectsOf(order)) {
          this.store.set(
            this.#key.reset(Tag5.slotObject).u32(slot).extendedGuid(object.id).done(),
            this.#value.reset().u32(object.order).done()
          );
        }
      }
      for (const root of this.index.rootObjectsOf(chained)) {
        this.store.set(
          this.#key.reset(Tag5.slotRoot).u32(slot).u32(root.role).done(),
          this.#value.reset().extendedGuid(root.objectId).done()
        );
      }
    }
  }
  /** @internal */
  objectInSlot(slot, id) {
    const order = this.#number(this.#key.reset(Tag5.slotObject).u32(slot).extendedGuid(id).done());
    return order === void 0 ? void 0 : this.index.objectAt(order);
  }
  /** @internal */
  rootInSlot(slot, role) {
    const stored = this.store.get(this.#key.reset(Tag5.slotRoot).u32(slot).u32(role).done());
    if (!stored) return void 0;
    return this.objectInSlot(slot, new RecordReader(stored).extendedGuid());
  }
  // -- Objects ------------------------------------------------------------
  /**
   * The property set of one object, whichever encoding named it.
   *
   * The identifiers a set refers to are resolved differently in the two
   * encodings, and this is where that is decided — the only place above the
   * index where it has to be.
   */
  propertiesOf(object) {
    if (!object.propertySet) return void 0;
    return this.properties.viewOf(object.order, object.propertySet, this.compactIdsFor(object));
  }
  compactIdsFor(object) {
    if (!this.#packaged) return new DesktopCompactIds(this.index, object.globalIdScope ?? -1);
    return new PackagedCompactIds(this, object);
  }
  /**
   * The bytes an object's file-data reference names, as a range.
   *
   * The two encodings link an object to its bytes differently. A desktop
   * object carries the `<ifndf>{GUID}` name of an entry in the file-data
   * store, and the index is keyed by exactly that. A packaged object carries
   * the same reference as a property, but the bytes are in a data element the
   * object itself declared — so the declaration is followed rather than the
   * name, which is both shorter and what the format actually links.
   */
  fileDataRangeOf(object) {
    if (this.#packaged) {
      return object.blobId ? this.index.fileData(indexedGuidKey(object.blobId))?.payload : void 0;
    }
    const reference = object.fileDataReference;
    if (!reference || !reference.toLowerCase().startsWith("<ifndf>")) return void 0;
    const value = reference.slice(7).trim().replace(/\0+$/, "").replace(/^\{|\}$/g, "").toLowerCase();
    return this.index.fileData(value)?.payload;
  }
  // -- Store helpers ------------------------------------------------------
  #spaceAt(ordinal) {
    const stored = this.store.get(this.#key.reset(Tag5.spaceByOrdinal).u32(ordinal).done());
    return new RecordReader(stored).extendedGuid();
  }
  *#ordersFor(id) {
    const count = this.#number(this.#key.reset(Tag5.revisionByGuidCount).extendedGuid(id).done()) ?? 0;
    for (let position = 0; position < count; position++) {
      yield this.#number(this.#key.reset(Tag5.revisionByGuid).extendedGuid(id).u32(position).done());
    }
  }
  /** The last revision order carrying an identifier, as the eager map keeps. */
  #lastRevisionFor(id) {
    let last;
    for (const order of this.#ordersFor(id)) last = order;
    return last;
  }
  #number(key) {
    const stored = this.store.get(key);
    return stored ? new RecordReader(stored).u32() : void 0;
  }
  /** Read a counter, store it incremented, and answer with the old value. */
  #bump(build) {
    const key = build(this.#counterKey).done();
    const count = this.#number(key) ?? 0;
    this.store.set(key, this.#counterValue.reset().u32(count + 1).done());
    return count;
  }
  /** @internal Used by the packaged identifier table. */
  get sharedStore() {
    return this.store;
  }
};
function contextEquals2(left, right) {
  if (!left) return !right;
  if (!right) return false;
  return indexedGuidKey(left) === indexedGuidKey(right);
}
var DesktopCompactIds = class {
  constructor(index, scope) {
    this.index = index;
    this.scope = scope;
  }
  identifier(globalIndex) {
    return this.scope < 0 ? void 0 : this.index.globalId(this.scope, globalIndex);
  }
};
var PackagedCompactIds = class {
  #resolver;
  #object;
  #key = new RecordWriter(24);
  constructor(resolver, object) {
    this.#resolver = resolver;
    this.#object = object;
  }
  identifier(globalIndex) {
    this.#ensureBuilt();
    const stored = this.#resolver.sharedStore.get(
      this.#key.reset(Tag5.packagedIds).u32(this.#object.order).u32(globalIndex).done()
    );
    return stored ? new RecordReader(stored).guid() : void 0;
  }
  #ensureBuilt() {
    const store = this.#resolver.sharedStore;
    if (store.has(this.#key.reset(Tag5.packagedIdsBuilt).u32(this.#object.order).done())) return;
    const index = this.#resolver.index;
    const value = this.#object.propertySet;
    const streams = readStreamRanges(this.#resolver.window, value);
    const cell = this.#object.revisionOrder >= 0 ? this.#resolver.cellOf(this.#object.revisionOrder) : void 0;
    this.#pair(streams.object, this.#objectReferences(index), value.offset, "object");
    if (streams.objectSpace) {
      this.#pair(streams.objectSpace, this.#cellReferences(index, cell, true), value.offset, "object-space");
    }
    if (streams.context) {
      this.#pair(streams.context, this.#cellReferences(index, cell, false), value.offset, "context");
    }
    store.set(
      this.#key.reset(Tag5.packagedIdsBuilt).u32(this.#object.order).done(),
      EMPTY
    );
  }
  *#objectReferences(index) {
    yield* index.extendedGuidsIn(this.#object.objectReferences);
  }
  *#cellReferences(index, cell, own) {
    const cellKey = cell ? indexedGuidKey(cell.first) : void 0;
    for (const reference of index.cellIdsIn(this.#object.cellReferences)) {
      const matches2 = indexedGuidKey(reference.first) === cellKey;
      if (matches2 !== own) continue;
      yield own ? reference.second : reference.first;
    }
  }
  /**
   * Pair a CompactID stream with the Extended GUIDs it stands for.
   *
   * The low byte of a CompactID repeats the Extended GUID's ordinal, so a
   * misalignment is visible rather than silent. This is `addMappings` with the
   * arrays replaced by two cursors.
   */
  #pair(stream, extended, offset, kind) {
    const store = this.#resolver.sharedStore;
    const reader = new RangeReader(this.#resolver.window, stream);
    const count = stream.length >>> 2;
    const writer = new RecordWriter(24);
    let position = 0;
    for (const id of extended) {
      if (position >= count) {
        throw new OneNoteFormatError(
          "ONENOTE_FSSHTTPB_MAPPING_COUNT",
          `The ${kind} CompactID and Extended GUID arrays have different lengths.`,
          offset
        );
      }
      const compact = reader.u32(position * 4);
      position++;
      if (compact === 0 && isNilGuid(id)) continue;
      const globalIndex = compact >>> 8;
      const ordinal = compact & 255;
      if (globalIndex >= 16777215 || id.identifier === NIL_GUID2 || id.value !== ordinal) {
        throw new OneNoteFormatError(
          "ONENOTE_FSSHTTPB_MAPPING",
          `A ${kind} mapping pairs a CompactID with an incompatible Extended GUID.`,
          offset
        );
      }
      const existing = store.get(
        this.#key.reset(Tag5.packagedIds).u32(this.#object.order).u32(globalIndex).done()
      );
      if (existing !== void 0 && new RecordReader(existing).guid() !== id.identifier) {
        throw new OneNoteFormatError(
          "ONENOTE_FSSHTTPB_MAPPING",
          "One CompactID global index maps to two different GUIDs.",
          offset
        );
      }
      store.set(
        this.#key.reset(Tag5.packagedIds).u32(this.#object.order).u32(globalIndex).done(),
        writer.reset().guid(id.identifier).done()
      );
    }
    if (position !== count) {
      throw new OneNoteFormatError(
        "ONENOTE_FSSHTTPB_MAPPING_COUNT",
        `The ${kind} CompactID and Extended GUID arrays have different lengths.`,
        offset
      );
    }
  }
};
function readStreamRanges(window, value) {
  const reader = new RangeReader(window, value);
  const read = (offset2) => {
    const header = reader.u32(offset2);
    return {
      range: { offset: value.offset + offset2 + 4, length: (header & 16777215) * 4 },
      extended: (header & 1073741824) !== 0,
      noOsid: (header & 2147483648) !== 0
    };
  };
  const object = read(0);
  let offset = 4 + object.range.length;
  let objectSpace;
  let context;
  if (!object.noOsid) {
    const osids = read(offset);
    objectSpace = osids.range;
    offset += 4 + osids.range.length;
    if (osids.extended) context = read(offset).range;
  }
  return { object: object.range, objectSpace, context };
}

// src/resolve/values.ts
function findProperty2(view, propertyId) {
  return view?.find(propertyId);
}
function dataRange(view, propertyId) {
  return view?.find(propertyId)?.data;
}
function readBoolean2(view, propertyId) {
  return view?.find(propertyId)?.booleanValue;
}
function readUInt32Property2(view, propertyId) {
  const value = view?.find(propertyId)?.scalarValue;
  return value === void 0 ? void 0 : value >>> 0;
}
function readFloat2(view, propertyId) {
  const range = dataRange(view, propertyId);
  if (!range || range.length !== 4) return void 0;
  const bytes = view.window.peek(range.offset, 4);
  return new DataView(bytes.buffer, bytes.byteOffset, 4).getFloat32(0, true);
}
function readFileTime2(view, propertyId) {
  const value = view?.find(propertyId)?.scalarValue;
  if (value === void 0 || value === 0) return void 0;
  const milliseconds = value / 1e4 - 116444736e5;
  return Number.isFinite(milliseconds) ? new Date(milliseconds) : void 0;
}
function readTime322(view, propertyId) {
  const value = readUInt32Property2(view, propertyId);
  return value === void 0 ? void 0 : new Date(Date.UTC(1980, 0, 1) + value * 1e3);
}
var NO_UINT32_VALUES = {
  count: 0,
  at: () => {
    throw new RangeError("No values to read.");
  }
};
function uint32Values(view, propertyId) {
  const range = dataRange(view, propertyId);
  if (!range || range.length % 4 !== 0 || range.length === 0) return NO_UINT32_VALUES;
  const reader = new RangeReader(view.window, range);
  return { count: range.length >>> 2, at: (index) => reader.u32(index * 4) };
}
function* references(view, propertyId) {
  if (!view) return;
  yield* view.references(view.find(propertyId));
}
function firstReference(view, propertyId) {
  for (const id of references(view, propertyId)) return id;
  return void 0;
}
function trimTrailingNulls2(value) {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 0) end--;
  return value.slice(0, end);
}
function readString2(view, propertyId, limit = Infinity, describe2 = "A metadata value", meter) {
  const range = dataRange(view, propertyId);
  if (!range || range.length === 0) return void 0;
  const units = range.length >>> 1;
  if (units > limit) throw overValueLimit(describe2, units, limit, "maxValueChars");
  meter?.value(units);
  let value = "";
  for (const piece of utf16Text(view.window, range, 0, units)) value += piece;
  return trimTrailingNulls2(value);
}
function textSource(view, utf16PropertyId, singleBytePropertyId) {
  const wide = dataRange(view, utf16PropertyId);
  if (wide && wide.length > 0) {
    return { range: wide, encoding: "utf-16", length: utf16Length(view.window, wide) };
  }
  const narrow = dataRange(view, singleBytePropertyId);
  if (narrow && narrow.length > 0) {
    return { range: narrow, encoding: "single-byte", length: asciiLength(view.window, narrow) };
  }
  return void 0;
}
function* textSlice(view, source, start, end) {
  if (source.encoding === "utf-16") yield* utf16Text(view.window, source.range, start, end);
  else yield* asciiText(view.window, source.range, start, end);
}

// src/stream/markdown.ts
var encoder4 = new TextEncoder();
var ByteOut = class {
  #target;
  #buffer;
  #length = 0;
  constructor(target, capacity = 8192) {
    this.#target = target;
    this.#buffer = new Uint8Array(capacity);
  }
  get bufferBytes() {
    return this.#buffer.byteLength;
  }
  async text(piece) {
    if (piece !== "") await this.bytes(encoder4.encode(piece));
  }
  async bytes(chunk) {
    if (chunk.byteLength >= this.#buffer.byteLength) {
      await this.flush();
      await this.#target.write(chunk);
      return;
    }
    if (this.#length + chunk.byteLength > this.#buffer.byteLength) await this.flush();
    this.#buffer.set(chunk, this.#length);
    this.#length += chunk.byteLength;
  }
  async flush() {
    if (this.#length === 0) return;
    const pending = this.#buffer.subarray(0, this.#length);
    this.#length = 0;
    await this.#target.write(pending);
  }
};
var NoteWriter = class {
  out;
  #collapser;
  #trimmer;
  #started = false;
  #previousListItem = false;
  #openCallout;
  #quoting = false;
  constructor(target, trailing, bufferBytes = 8192) {
    this.out = new ByteOut(target, bufferBytes);
    this.#trimmer = new Trimmer((piece) => this.out.text(piece), trailing);
    this.#collapser = new NewlineCollapser((piece) => this.#trimmer.push(piece));
  }
  /** Text that bypasses collapsing and trimming: front matter, and the end. */
  async raw(text) {
    await this.out.text(text);
  }
  async beginBlock(listItem) {
    await this.#separate(listItem);
    this.#openCallout = void 0;
    this.#quoting = false;
  }
  /**
   * Open a callout, continuing the one above if it has the same heading.
   *
   * A continuation is not a new block: it is appended to the one already
   * there, which is why no separator is written and why the previous-block
   * state is left alone.
   */
  async beginCallout(opening) {
    if (this.#openCallout === opening) await this.#push("\n>\n");
    else {
      await this.#separate(false);
      await this.#push(`${opening}
`);
      this.#openCallout = opening;
    }
    this.#quoting = true;
    await this.#push("> ");
  }
  /** Body text of the block that is open. */
  async push(text) {
    if (text === "") return;
    await this.#push(this.#quoting ? text.replace(/\n/g, "\n> ") : text);
  }
  async finish() {
    await this.#collapser.finish();
    await this.#trimmer.finish();
    await this.out.text("\n");
    await this.out.flush();
  }
  async #separate(listItem) {
    if (this.#started) await this.#push(this.#previousListItem && listItem ? "\n" : "\n\n");
    this.#previousListItem = listItem;
    this.#started = true;
  }
  async #push(text) {
    await this.#collapser.push(text);
  }
};

// src/stream/ink.ts
var PADDING2 = 10;
var POINT_BYTES = 16;
var COORDINATE_BYTES = 8;
var InkPathCursor = class {
  #reader;
  /**
   * One buffer, filled again for each step.
   *
   * A copy rather than a view into the read window, and reused rather than
   * allocated per step. The window's own buffer would do — nothing between
   * two refills here touches it — but that is true by inspection of the
   * loop below rather than by construction, and a window read added to the
   * point handler one day would corrupt the path being decoded without
   * anything to say so. One buffer for the cursor's lifetime costs a chunk,
   * which the budget names, and cannot be aliased by anyone.
   */
  #buffer;
  /** Bytes of `#buffer` that are filled. */
  #filled = 0;
  /** Where `#buffer` starts, as an offset into the range. */
  #chunkAt = 0;
  /** How far the walk has got, as an offset into the range. */
  #at = 0;
  constructor(reader, stepBytes) {
    this.#reader = reader;
    this.#buffer = new Uint8Array(
      Math.max(1, Math.min(stepBytes, reader.window.capacity))
    );
  }
  /** Whether the walk has reached the end of the path. */
  get exhausted() {
    return this.#at >= this.#reader.length;
  }
  /**
   * The next integer, decoded exactly as the eager reader decodes it.
   *
   * Including the failures: the same three conditions produce the same three
   * codes, because a file that was malformed before must still be malformed.
   */
  varUInt() {
    let value = 0;
    let shift = 1;
    for (let index = 0; index < 10; index++) {
      if (this.exhausted) {
        throw new OneNoteFormatError(
          "ONENOTE_INK_VARINT",
          "The ink path contains a truncated multi-byte integer."
        );
      }
      const current = this.#next();
      value += (current & 127) * shift;
      if ((current & 128) === 0) return value;
      shift *= 128;
      if (shift > Number.MAX_SAFE_INTEGER) {
        throw new OneNoteFormatError(
          "ONENOTE_INK_VARINT",
          "The ink path contains a multi-byte integer wider than supported."
        );
      }
    }
    throw new OneNoteFormatError(
      "ONENOTE_INK_VARINT",
      "The ink path contains an invalid multi-byte integer."
    );
  }
  #next() {
    if (this.#at >= this.#chunkAt + this.#filled) {
      const take = Math.min(this.#buffer.byteLength, this.#reader.length - this.#at);
      this.#buffer.set(this.#reader.peek(this.#at, take));
      this.#filled = take;
      this.#chunkAt = this.#at;
    }
    return this.#buffer[this.#at++ - this.#chunkAt];
  }
};
function decodeInkPath(reader, stepBytes, spool, dimensionCount, xIndex, yIndex, maximumValues, emit) {
  if (reader.length === 0) return false;
  const cursor = new InkPathCursor(reader, stepBytes);
  const count = Math.floor(cursor.varUInt() / 2);
  if (count > maximumValues) {
    throw new OneNoteFormatError(
      "ONENOTE_INK_PATH_LIMIT",
      "The ink path exceeds the configured property value limit."
    );
  }
  if (count === 0) return false;
  const divides = count % dimensionCount === 0;
  const pointCount = divides ? count / dimensionCount : 0;
  const firstBlock = Math.min(xIndex, yIndex) * pointCount;
  const secondBlock = Math.max(xIndex, yIndex) * pointCount;
  const firstIsX = xIndex <= yIndex;
  spool.reset();
  const scratch = new Uint8Array(COORDINATE_BYTES);
  const scratchView = new DataView(scratch.buffer);
  let firstSum = 0;
  let secondSum = 0;
  let paired = 0;
  let cursorInto;
  for (let index = 0; index < count; index++) {
    if (cursor.exhausted) {
      throw new OneNoteFormatError(
        "ONENOTE_INK_PATH_TRUNCATED",
        "The ink path ends before all declared coordinates were decoded."
      );
    }
    const encoded = cursor.varUInt();
    const magnitude = Math.floor(encoded / 2);
    const value = (encoded & 1) === 0 ? magnitude : -magnitude;
    if (!divides) continue;
    if (index >= firstBlock && index < firstBlock + pointCount) {
      firstSum = index === firstBlock ? value : firstSum + value;
      if (firstBlock === secondBlock) emit(firstSum, firstSum);
      else {
        scratchView.setFloat64(0, firstSum, true);
        spool.write(scratch);
      }
      continue;
    }
    if (index >= secondBlock && index < secondBlock + pointCount) {
      secondSum = index === secondBlock ? value : secondSum + value;
      cursorInto ??= new SpoolCoordinates(spool);
      const other = cursorInto.next();
      emit(firstIsX ? other : secondSum, firstIsX ? secondSum : other);
      paired++;
    }
  }
  if (!divides) return false;
  if (firstBlock !== secondBlock && paired !== pointCount) {
    throw new OneNoteFormatError(
      "ONENOTE_INK_PATH_TRUNCATED",
      `The ink path paired ${paired} of ${pointCount} points.`
    );
  }
  return true;
}
var SpoolCoordinates = class {
  #chunks;
  #view;
  #at = 0;
  constructor(spool) {
    this.#chunks = spool.chunks();
  }
  next() {
    if (!this.#view || this.#at >= this.#view.byteLength) {
      const step = this.#chunks.next();
      if (step.done) {
        throw new OneNoteFormatError(
          "ONENOTE_INK_PATH_TRUNCATED",
          "The ink path has more coordinates on one axis than the other."
        );
      }
      this.#view = new DataView(step.value.buffer, step.value.byteOffset, step.value.byteLength);
      this.#at = 0;
    }
    const value = this.#view.getFloat64(this.#at, true);
    this.#at += COORDINATE_BYTES;
    return value;
  }
};
var StrokeCollector = class {
  minX = Infinity;
  minY = Infinity;
  maxX = -Infinity;
  maxY = -Infinity;
  #points;
  #strokes;
  #point = new Uint8Array(POINT_BYTES);
  #pointView;
  #record = new RecordWriter(64);
  #pointCount = 0;
  #drawable = 0;
  constructor(points, strokes) {
    this.#points = points;
    this.#strokes = strokes;
    this.#pointView = new DataView(this.#point.buffer);
  }
  /** Strokes with at least one point, which are the ones that are drawn. */
  get drawableCount() {
    return this.#drawable;
  }
  get strokeCount() {
    return this.#strokes.count;
  }
  /**
   * Begin a stroke. Points are pushed after it, then `endStroke` closes it.
   *
   * Kept open rather than taking an array because the points come out of a
   * delta-decoder one at a time and collecting them first would be the
   * allocation this avoids.
   */
  beginStroke() {
    return this.#pointCount;
  }
  pushPoint(x, y) {
    this.#pointView.setFloat64(0, x, true);
    this.#pointView.setFloat64(8, y, true);
    this.#points.write(this.#point);
    this.#pointCount++;
    if (x < this.minX) this.minX = x;
    if (y < this.minY) this.minY = y;
    if (x > this.maxX) this.maxX = x;
    if (y > this.maxY) this.maxY = y;
  }
  endStroke(firstPoint, color, width, opacity) {
    const pointCount = this.#pointCount - firstPoint;
    if (pointCount > 0) this.#drawable++;
    this.#strokes.push(this.#record.reset().text(color).f64(width).f64(opacity).u32(firstPoint).u32(pointCount).done());
  }
  strokeAt(position) {
    const reader = new RecordReader(this.#strokes.at(position));
    return {
      color: reader.text(),
      width: reader.f64(),
      opacity: reader.f64(),
      firstPoint: reader.u32(),
      pointCount: reader.u32()
    };
  }
  /**
   * The points of one stroke, read back in order.
   *
   * The spool is a byte stream, so a point can straddle a chunk boundary in
   * principle; the leftover is carried rather than assumed away.
   */
  *pointsOf(stroke) {
    if (stroke.pointCount === 0) return;
    const start = stroke.firstPoint * POINT_BYTES;
    const end = start + stroke.pointCount * POINT_BYTES;
    const carry = new Uint8Array(POINT_BYTES);
    const carryView = new DataView(carry.buffer);
    let position = 0;
    let held = 0;
    for (const chunk of this.#points.chunks()) {
      const chunkEnd = position + chunk.byteLength;
      if (chunkEnd <= start) {
        position = chunkEnd;
        continue;
      }
      if (position >= end) break;
      const from = Math.max(0, start - position);
      const to = Math.min(chunk.byteLength, end - position);
      for (let at = from; at < to; at++) {
        carry[held++] = chunk[at];
        if (held < POINT_BYTES) continue;
        held = 0;
        yield { x: carryView.getFloat64(0, true), y: carryView.getFloat64(8, true) };
      }
      position = chunkEnd;
    }
  }
  reset() {
    this.#points.reset();
    this.#strokes.reset();
    this.#pointCount = 0;
    this.#drawable = 0;
    this.minX = Infinity;
    this.minY = Infinity;
    this.maxX = -Infinity;
    this.maxY = -Infinity;
  }
};
function writeInkSvg(strokes, into) {
  if (strokes.drawableCount === 0) return false;
  const { minX, minY, maxX, maxY } = strokes;
  const width = maxX - minX + PADDING2 * 2;
  const height = maxY - minY + PADDING2 * 2;
  into.reset();
  into.writeText(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
  );
  let written = 0;
  for (let position = 0; position < strokes.strokeCount; position++) {
    const stroke = strokes.strokeAt(position);
    if (stroke.pointCount === 0) continue;
    if (written > 0) into.writeText("\n");
    written++;
    const opacityAttr = stroke.opacity < 1 ? ` opacity="${stroke.opacity.toFixed(2)}"` : "";
    if (stroke.pointCount === 1) {
      for (const { x, y } of strokes.pointsOf(stroke)) {
        into.writeText(
          `<circle cx="${x - minX + PADDING2}" cy="${y - minY + PADDING2}" r="${stroke.width / 2}" fill="${stroke.color}"${opacityAttr}/>`
        );
      }
      continue;
    }
    into.writeText('<path d="');
    let index = 0;
    for (const { x, y } of strokes.pointsOf(stroke)) {
      into.writeText(`${index === 0 ? "M" : " L"} ${x - minX + PADDING2} ${y - minY + PADDING2}`);
      index++;
    }
    into.writeText(
      `" stroke="${stroke.color}" stroke-width="${stroke.width}" fill="none" stroke-linecap="round" stroke-linejoin="round"${opacityAttr}/>`
    );
  }
  into.writeText("</svg>");
  return true;
}
var DIMENSION_BYTES = 32;
function readInkDimensions(reader, xId, yId) {
  if (!reader || reader.length === 0) return { count: 0, xIndex: -1, yIndex: -1 };
  const count = Math.floor(reader.length / DIMENSION_BYTES);
  let xIndex = -1;
  let yIndex = -1;
  for (let index = 0; index < count; index++) {
    if (xIndex >= 0 && yIndex >= 0) break;
    const id = readDimensionId(reader, index * DIMENSION_BYTES);
    if (xIndex < 0 && id === xId) xIndex = index;
    if (yIndex < 0 && id === yId) yIndex = index;
  }
  return { count, xIndex, yIndex };
}
function readDimensionId(reader, offset) {
  const bytes = reader.peek(offset, 16);
  const hex = (index) => bytes[index].toString(16).padStart(2, "0");
  return [
    hex(3) + hex(2) + hex(1) + hex(0),
    hex(5) + hex(4),
    hex(7) + hex(6),
    hex(8) + hex(9),
    hex(10) + hex(11) + hex(12) + hex(13) + hex(14) + hex(15)
  ].join("-");
}

// src/stream/page.ts
var PIXELS_PER_INK_UNIT2 = 48;
var MAX_TAGS_PER_PARAGRAPH2 = 9;
var INVISIBLE_MATH2 = /[\u2061-\u2064]/g;
var SUPERSCRIPTS2 = "\u2070\xB9\xB2\xB3\u2074\u2075\u2076\u2077\u2078\u2079\u207A\u207B\u207C\u207D\u207E\u207F\u2071\xB9\xB2\xB3";
var SUPERSCRIPT_PLAIN2 = "0123456789+-=()ni123";
var SUBSCRIPTS2 = "\u2080\u2081\u2082\u2083\u2084\u2085\u2086\u2087\u2088\u2089\u208A\u208B\u208C\u208D\u208E";
var SUBSCRIPT_PLAIN2 = "0123456789+-=()";
var CALLOUT_SHAPES2 = {
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
var HIGHLIGHT_MARKERS2 = [
  { marker: "\u{1F534}", inks: [[255, 0, 0], [255, 105, 180]] },
  { marker: "\u{1F7E0}", inks: [[255, 165, 0]] },
  { marker: "\u{1F7E1}", inks: [[255, 255, 0]] },
  { marker: "\u{1F7E2}", inks: [[0, 255, 0], [0, 128, 0]] },
  { marker: "\u{1F535}", inks: [[0, 0, 255], [0, 255, 255]] },
  { marker: "\u{1F7E3}", inks: [[128, 0, 128], [255, 0, 255]] }
];
var StoreTag = {
  recognition: 40,
  recognitionVisited: 41
};
var EMPTY2 = new Uint8Array(0);
var HARD_BREAK = "  \n";
var EMPTY_CHILDREN = {
  count: 0,
  at: () => {
    throw new RangeError("No children to read.");
  }
};
function one(id) {
  return { count: 1, at: () => id };
}
async function writeSeparatorRow(columns, emit) {
  await emit("\n| ");
  for (let column = 0; column < columns; column++) await emit(column === 0 ? "---" : " | ---");
  await emit(" |");
}
var TextParts = class {
  constructor(limit, meter) {
    this.limit = limit;
    this.meter = meter;
  }
  value = "";
  add(part) {
    if (part.trim() === "") return;
    this.value = joinBounded(this.value, part, this.limit, "A page title", this.meter);
  }
};
var Doc = class {
  constructor(resolver, space) {
    this.resolver = resolver;
    this.space = space;
  }
  object(id) {
    return this.space.object(id);
  }
  view(object) {
    return object ? this.resolver.propertiesOf(object) : void 0;
  }
  viewOf(id) {
    return this.view(this.object(id));
  }
};
var PageRenderer = class {
  #resolver;
  #store;
  #spills;
  #assets;
  #options;
  #limits;
  #key = new RecordWriter(64);
  #value = new RecordWriter(128);
  #doc;
  #note;
  #page;
  #strokes;
  /** Recognized words already accepted, and the last of them for comparison. */
  #recognizedCount = 0;
  #lastRecognized;
  #recognitionSlot = 0;
  constructor(resolver, store, spills, assets, options, limits = DEFAULT_STREAM_LIMITS) {
    this.#resolver = resolver;
    this.#store = store;
    this.#spills = spills;
    this.#assets = assets;
    this.#options = options;
    this.#limits = limits;
  }
  /**
   * Write one page's body into `note`.
   *
   * The order is `convertPage`'s: outlines, then anything attached directly to
   * the page, then the ink gathered along the way.
   */
  async render(space, pageNode, note, page) {
    this.#doc = new Doc(this.#resolver, space);
    this.#note = note;
    this.#page = page;
    this.#strokes = new StrokeCollector(this.#spills.inkPoints, this.#spills.inkStrokes);
    this.#strokes.reset();
    this.#spills.recognized.reset();
    this.#recognizedCount = 0;
    this.#lastRecognized = void 0;
    this.#recognitionSlot = space.slot;
    const view = this.#doc.view(pageNode);
    this.#collectRecognition(view);
    const children = this.#children(view, Property.elementChildNodes);
    for (let index = 0; index < children.count; index++) {
      if (page.isCancelled?.()) throw new ConversionCancelled();
      await this.#element(children.at(index), 0, /* @__PURE__ */ new Set());
    }
    await this.#writeCollectedInk();
  }
  /**
   * The text of a page's title nodes, for a page whose cached title is blank.
   *
   * `mapPage` reaches this by building the title's elements and reading their
   * text back out, so what it produces is the runs' own text rather than
   * their Markdown — no escaping, no emphasis markers, no links. The parts
   * are joined the way `collectText` joins them, and the last title node in
   * the page wins, both of which are that function's behaviour rather than a
   * choice made here.
   *
   * A title is a title, so this is one of the few strings built whole.
   */
  collectTitle(space, pageNode) {
    this.#doc = new Doc(this.#resolver, space);
    this.#recognitionSlot = space.slot;
    this.#strokes = new StrokeCollector(this.#spills.titleInkPoints, this.#spills.titleInkStrokes);
    this.#strokes.reset();
    const pageView = this.#doc.view(pageNode);
    this.#collectRecognition(pageView);
    let title = "";
    for (const titleId of references(pageView, Property.structureElementChildNodes)) {
      const titleNode = this.#doc.object(titleId);
      if (titleNode?.jcid !== Jcid.titleNode) continue;
      const parts = new TextParts(this.#limits.maxValueChars, this.#limits.meter);
      const children = this.#children(this.#doc.view(titleNode), Property.elementChildNodes);
      for (let index = 0; index < children.count; index++) {
        this.#textOf(children.at(index), 0, /* @__PURE__ */ new Set(), parts);
      }
      title = parts.value.trim();
    }
    return title;
  }
  /**
   * What one element contributes to a title.
   *
   * This is `buildElement` and `collectText` fused: the same dispatch, but
   * only the branches that produce text, and no element in between. A run is
   * one part, as it is there — two adjacent runs are separated by a space in
   * a title even though they are adjacent in the paragraph.
   */
  #textOf(id, depth, path, into) {
    const key = indexedGuidKey(id);
    if (depth >= this.#options.maxPropertySetDepth || path.has(key)) return;
    path.add(key);
    try {
      const object = this.#doc.object(id);
      if (!object) return;
      const view = this.#doc.view(object);
      switch (object.jcid) {
        case Jcid.outlineNode:
        case Jcid.outlineGroup:
          this.#eachChild(view, Property.elementChildNodes, depth, path, into);
          return;
        case Jcid.outlineElementNode: {
          const content = this.#children(view, Property.contentChildNodes);
          for (let index = 0; index < content.count; index++) {
            const contentId = content.at(index);
            const candidate = this.#doc.object(contentId);
            if (!candidate) continue;
            if (candidate.jcid === Jcid.inkContainer) {
              if (this.#inkText(candidate, into) !== void 0) break;
              continue;
            }
            if (HANDLED.has(candidate.jcid)) {
              this.#textOf(contentId, depth + 1, path, into);
              break;
            }
          }
          this.#eachChild(view, Property.elementChildNodes, depth, path, into);
          return;
        }
        case Jcid.richTextNode: {
          const source = view && textSource(view, Property.richEditTextUnicode, Property.textExtendedAscii);
          if (!view || !source) return;
          const boundaries = uint32Values(view, Property.textRunIndex);
          const runCount = Math.max(1, boundaries.count + 1);
          let start = 0;
          for (let index = 0; index < runCount; index++) {
            let end = index < boundaries.count ? Math.min(source.length, boundaries.at(index)) : source.length;
            if (end < start) end = start;
            this.#limits.meter?.value(end - start);
            if (end - start > this.#limits.maxValueChars) {
              throw overValueLimit(
                "A title's text run",
                end - start,
                this.#limits.maxValueChars,
                "maxValueChars"
              );
            }
            const field = this.#findHyperlinkField(view, source, start, end);
            let run = "";
            for (const piece of this.#runPieces(view, source, start, end, field)) run += piece;
            into.add(run);
            start = end;
          }
          return;
        }
        case Jcid.tableNode:
          for (const rowId of this.#ofKind(
            this.#children(view, Property.elementChildNodes),
            Jcid.tableRowNode
          )) {
            for (const cellId of this.#cellsOf(rowId)) {
              this.#eachChild(
                this.#doc.viewOf(cellId),
                Property.elementChildNodes,
                depth,
                path,
                into
              );
            }
          }
          return;
        case Jcid.inkContainer:
          this.#inkText(object, into);
          return;
        default:
          return;
      }
    } finally {
      path.delete(key);
    }
  }
  #eachChild(view, propertyId, depth, path, into) {
    const children = this.#children(view, propertyId);
    for (let index = 0; index < children.count; index++) {
      this.#textOf(children.at(index), depth + 1, path, into);
    }
  }
  /** An ink container's recognized words, with its strokes thrown away. */
  #inkText(object, into) {
    const words = this.#inkInto(object, this.#strokes);
    if (words) into.add(words);
    return words;
  }
  // -- Walking ------------------------------------------------------------
  /**
   * The identifiers a property names, addressed rather than listed.
   *
   * A level's children are read by position, so walking a page with a hundred
   * thousand top-level elements never puts a hundred thousand identifiers in
   * heap — the walk holds an index, and each step reads four bytes.
   */
  #children(view, propertyId) {
    const property = view?.find(propertyId);
    if (!view || !property?.referenceCount) return EMPTY_CHILDREN;
    return {
      count: property.referenceCount,
      at: (index) => view.referenceAt(property, index)
    };
  }
  async #element(id, depth, path) {
    const key = indexedGuidKey(id);
    if (depth >= this.#options.maxPropertySetDepth || path.has(key)) return false;
    path.add(key);
    try {
      const object = this.#doc.object(id);
      if (!object) return false;
      switch (object.jcid) {
        case Jcid.outlineNode:
        case Jcid.outlineGroup: {
          const children = this.#children(this.#doc.view(object), Property.elementChildNodes);
          for (let index = 0; index < children.count; index++) {
            await this.#element(children.at(index), depth + 1, path);
          }
          return true;
        }
        case Jcid.outlineElementNode:
          await this.#outlineElement(object, depth, path);
          return true;
        case Jcid.richTextNode:
          await this.#paragraph(object, void 0, void 0, depth, path);
          return true;
        case Jcid.imageNode:
          await this.#image(object);
          return true;
        case Jcid.embeddedFileNode:
          await this.#embeddedFile(object);
          return true;
        case Jcid.tableNode:
          await this.#table(object, depth, path);
          return true;
        case Jcid.inkContainer:
          return this.#ink(object);
        default:
          return false;
      }
    } finally {
      path.delete(key);
    }
  }
  /**
   * An outline element: a list level and tags wrapped around one child.
   *
   * `buildOutlineElement` folds those into the child when it is a paragraph
   * and leaves them off when it is not, so which child is the primary one has
   * to be settled before anything is written. Settling it costs a type
   * lookup per candidate, except for ink — whose emptiness is only knowable
   * by decoding it, and which is collected rather than written, so trying it
   * is harmless.
   */
  async #outlineElement(object, depth, path) {
    const view = this.#doc.view(object);
    const list = this.#listInfo(view);
    const tags = this.#tags(view);
    const children = this.#children(view, Property.elementChildNodes);
    const content = this.#children(view, Property.contentChildNodes);
    let primary;
    let primaryIsParagraph = false;
    let primaryIsInk = false;
    for (let index = 0; index < content.count; index++) {
      const contentId = content.at(index);
      const candidate = this.#doc.object(contentId);
      if (!candidate) continue;
      if (candidate.jcid === Jcid.richTextNode) {
        primary = contentId;
        primaryIsParagraph = true;
        break;
      }
      if (candidate.jcid === Jcid.inkContainer) {
        if (await this.#element(contentId, depth + 1, path)) {
          primary = contentId;
          primaryIsInk = true;
          break;
        }
        continue;
      }
      if (HANDLED.has(candidate.jcid)) {
        primary = contentId;
        break;
      }
    }
    if (primary && primaryIsParagraph) {
      await this.#paragraph(this.#doc.object(primary), list, tags, depth, path, children);
      return;
    }
    if (primary && !primaryIsInk) await this.#element(primary, depth + 1, path);
    for (let index = 0; index < children.count; index++) {
      await this.#element(children.at(index), depth + 1, path);
    }
  }
  // -- Paragraphs ---------------------------------------------------------
  /**
   * Render one rich-text node as a block, then whatever hangs off it.
   *
   * The block is opened by the first character that survives trimming, so a
   * paragraph whose runs are all whitespace contributes nothing — which is
   * what `if (text !== '')` does in the string version, without needing the
   * text to exist first.
   */
  async #paragraph(object, list, inherited, depth, path, extra = EMPTY_CHILDREN) {
    const view = this.#doc.view(object);
    const tags = this.#tags(view) ?? inherited;
    const task = taskPrefix2(tags, list);
    const prefix = task ?? listPrefix2(list) ?? "";
    const indent = "	".repeat(list?.level ?? 0);
    const heading = headingPrefix2(this.#styleId(view));
    const callout = calloutFor2(tags);
    const asCallout = callout !== void 0 && !list && task === void 0;
    const body = new BlockBody(
      this.#note,
      this.#spills,
      prefix || heading,
      indent,
      asCallout ? () => this.#note.beginCallout(`> [!${callout.type}]${callout.title ? ` ${callout.title}` : ""}`) : () => this.#note.beginBlock(task !== void 0 || list !== void 0)
    );
    await this.#runs(view, body);
    await body.finish();
    for (let index = 0; index < extra.count; index++) {
      await this.#element(extra.at(index), depth + 1, path);
    }
  }
  /**
   * The text runs of a rich-text node, rendered into `into`.
   *
   * A run is a slice of one text property, addressed by boundaries stored
   * beside it — so a run is re-readable from the section as often as it needs
   * to be, and none of them are held.
   */
  async #runs(view, into) {
    if (!view) return;
    const source = textSource(view, Property.richEditTextUnicode, Property.textExtendedAscii);
    const boundaries = uint32Values(view, Property.textRunIndex);
    const styles = this.#children(view, Property.textRunFormatting);
    const length = source?.length ?? 0;
    const runCount = Math.max(1, boundaries.count + 1);
    let pending;
    let start = 0;
    for (let index = 0; index < runCount; index++) {
      let end = index < boundaries.count ? Math.min(length, boundaries.at(index)) : length;
      if (end < start) end = start;
      const style = {};
      if (index < styles.count) this.#applyStyle(style, styles.at(index));
      const field = source ? this.#findHyperlinkField(view, source, start, end) : void 0;
      if (field) pending = field.url;
      const remaining = end - start - (field ? field.length : 0);
      if (pending !== void 0 && remaining > 0) {
        style.hyperlinkUrl ??= pending;
        pending = void 0;
      }
      if (source && remaining > 0) await this.#run(view, source, start, end, field, style, into);
      start = end;
    }
  }
  /**
   * One run, as `renderRun` renders it.
   *
   * The leading and trailing whitespace sit outside whatever markers the
   * style adds, so both are held back until it is known whether anything
   * comes after them. A maths run is the exception: its LaTeX form is a
   * whole-string transform, so its core is built before it is written.
   */
  async #run(view, source, start, end, field, style, into) {
    const core = new CoreWriter(
      style,
      this.#page.resolveInternalLink,
      into,
      this.#spills.runWhitespace
    );
    if (style.math) {
      if (end - start > this.#limits.maxMathChars) {
        throw overValueLimit(
          "A maths run",
          end - start,
          this.#limits.maxMathChars,
          "maxMathChars"
        );
      }
      this.#limits.meter?.math(end - start);
      let text = "";
      for (const piece of this.#runPieces(view, source, start, end, field)) text += piece;
      await core.whole(text);
      return;
    }
    for (const piece of this.#runPieces(view, source, start, end, field)) await core.push(piece);
    await core.finish();
  }
  /** A run's text, with any HYPERLINK field removed, in pieces. */
  *#runPieces(view, source, start, end, field) {
    if (!field) {
      yield* textSlice(view, source, start, end);
      return;
    }
    if (field.start > start) yield* textSlice(view, source, start, field.start);
    if (field.start + field.length < end) yield* textSlice(view, source, field.start + field.length, end);
  }
  /**
   * Find `﷟ HYPERLINK "…"` inside a run, without reading it into a string.
   *
   * The pattern begins with a character that appears nowhere else, and every
   * quantifier in it is followed by something that whitespace cannot be — so
   * a left-to-right scan that never backtracks accepts exactly what the
   * regular expression accepts.
   */
  #findHyperlinkField(view, source, start, end) {
    let candidate = -1;
    let position = start;
    let state = "idle";
    let matched = 0;
    let url = "";
    const restart = () => {
      state = "idle";
      matched = 0;
      url = "";
      candidate = -1;
    };
    for (const piece of textSlice(view, source, start, end)) {
      for (let index = 0; index < piece.length; index++, position++) {
        const character = piece[index];
        const white = /\s/.test(character);
        if (state === "idle") {
          if (character === "\uFDDF") {
            candidate = position;
            state = "space";
          }
          continue;
        }
        if (state === "space") {
          if (white) continue;
          if (character === HYPERLINK_WORD[0]) {
            state = "word";
            matched = 1;
            if (HYPERLINK_WORD.length === 1) state = "gap";
            continue;
          }
          restart();
          if (character === "\uFDDF") {
            candidate = position;
            state = "space";
          }
          continue;
        }
        if (state === "word") {
          if (character === HYPERLINK_WORD[matched]) {
            matched++;
            if (matched === HYPERLINK_WORD.length) state = "gap";
            continue;
          }
          restart();
          if (character === "\uFDDF") {
            candidate = position;
            state = "space";
          }
          continue;
        }
        if (state === "gap") {
          if (white) {
            matched = -1;
            continue;
          }
          if (character === '"' && matched === -1) {
            state = "url";
            continue;
          }
          restart();
          if (character === "\uFDDF") {
            candidate = position;
            state = "space";
          }
          continue;
        }
        if (state === "url") {
          if (character !== '"') {
            if (url.length >= this.#limits.maxValueChars) {
              throw overValueLimit(
                "A hyperlink field's target",
                url.length + 1,
                this.#limits.maxValueChars,
                "maxValueChars"
              );
            }
            url += character;
            continue;
          }
          state = "tail";
          continue;
        }
        if (!white) {
          this.#limits.meter?.value(url.length);
          return { start: candidate, length: position - candidate, url };
        }
      }
    }
    return state === "tail" ? { start: candidate, length: position - candidate, url } : void 0;
  }
  #applyStyle(style, id) {
    const view = this.#doc.viewOf(id);
    if (!view) return;
    if (readBoolean2(view, Property.mathFormatting)) style.math = true;
    const highlight = highlightColor2(readUInt32Property2(view, Property.highlight));
    if (highlight) style.highlight = highlight;
    if (readBoolean2(view, Property.bold)) style.bold = true;
    if (readBoolean2(view, Property.italic)) style.italic = true;
    if (readBoolean2(view, Property.underline)) style.underline = true;
    if (readBoolean2(view, Property.strikethrough)) style.strikethrough = true;
    if (readBoolean2(view, Property.superscript)) style.superscript = true;
    if (readBoolean2(view, Property.subscript)) style.subscript = true;
    if (readBoolean2(view, Property.hyperlink)) {
      const url = readString2(view, Property.hyperlinkUrl, this.#limits.maxValueChars, "A hyperlink target", this.#limits.meter);
      if (url) style.hyperlinkUrl = url;
    }
  }
  #styleId(view) {
    for (const styleId of references(view, Property.paragraphStyle)) {
      const style = this.#doc.object(styleId);
      if (!style) continue;
      return readString2(
        this.#doc.view(style),
        Property.paragraphStyleId,
        this.#limits.maxValueChars,
        "A paragraph style identifier",
        this.#limits.meter
      );
    }
    return void 0;
  }
  // -- Tags and lists -----------------------------------------------------
  /** Maps tags by shape because labels are localized. */
  #tags(view) {
    if (!view) return void 0;
    const states = findProperty2(view, Property.noteTagStates);
    if (!states?.childCount) return void 0;
    const tags = [];
    const limit = Math.min(states.childCount, MAX_TAGS_PER_PARAGRAPH2);
    for (let position = 0; position < limit; position++) {
      const state = view.childAt(states, position);
      const status = findProperty2(state, Property.actionItemStatus)?.scalarValue ?? 0;
      if ((status & 16) !== 0) continue;
      const definitionId = firstReference(state, Property.noteTagDefinitionOid);
      const definition = definitionId ? this.#doc.object(definitionId) : void 0;
      const definitionView = this.#doc.view(definition);
      const shape = findProperty2(state, Property.noteTagShape)?.scalarValue ?? (definition?.jcid === Jcid.noteTagSharedDefinition ? readUInt32Property2(definitionView, Property.noteTagShape) : void 0);
      const checkable = shape !== void 0 && isCheckableShape2(shape);
      tags.push({
        checkable,
        completed: (status & 1) !== 0,
        label: checkable ? void 0 : readString2(
          definitionView,
          Property.noteTagLabel,
          this.#limits.maxValueChars,
          "A note tag label",
          this.#limits.meter
        ),
        shape
      });
    }
    return tags.length > 0 ? tags : void 0;
  }
  #listInfo(view) {
    let listView;
    for (const listId of references(view, Property.listNodes)) {
      const candidate = this.#doc.object(listId);
      if (candidate?.jcid === Jcid.numberListNode) listView = this.#doc.view(candidate);
    }
    if (!listView) return void 0;
    const format2 = this.#numberListFormat(listView);
    return {
      level: Math.max(0, (readUInt32Property2(view, Property.outlineElementChildLevel) ?? 1) - 1),
      ordered: format2.indexOf("\uFFFD") >= 0,
      format: format2 === "" ? void 0 : format2
    };
  }
  /**
   * A numbered list's format string.
   *
   * The value's first unit says how many units after it belong to the format,
   * and that unit is a `charCodeAt`, so the answer can never be longer than
   * 65,535 characters however large the property claims to be. Only that much
   * of it is decoded — plus the unit after, because a surrogate pair is only
   * a pair when its other half is in the same decode, and cutting the value
   * short would turn a character into a replacement the whole-value read
   * never produced.
   */
  #numberListFormat(view) {
    const range = dataRange(view, Property.numberListFormat);
    if (!range || range.length < 2) return "";
    const units = range.length >>> 1;
    let value = "";
    for (const piece of utf16Text(view.window, range, 0, Math.min(units, 65538))) value += piece;
    if (value.length === 0) return "";
    return value.slice(1, 1 + Math.min(value.charCodeAt(0), units - 1));
  }
  // -- Tables -------------------------------------------------------------
  /**
   * A table, written a row at a time.
   *
   * GFM needs the column count before the separator row, and the count is the
   * widest row — so the rows are counted first and rendered second. Counting
   * reads identifiers only; nothing in a cell is touched until the pass that
   * writes it, which is what keeps an image inside a cell from being saved
   * twice.
   */
  async #table(object, depth, path) {
    const view = this.#doc.view(object);
    const rows = this.#children(view, Property.elementChildNodes);
    let rowCount = 0;
    let columns = 0;
    for (const rowId of this.#ofKind(rows, Jcid.tableRowNode)) {
      rowCount++;
      let cells = 0;
      for (const _ of this.#cellsOf(rowId)) cells++;
      if (cells > columns) columns = cells;
    }
    if (rowCount === 0) return;
    if (columns > this.#limits.maxTableColumns) {
      throw overCountLimit(
        "A table's column count",
        columns,
        this.#limits.maxTableColumns,
        "maxTableColumns"
      );
    }
    await this.#note.beginBlock(false);
    let index = 0;
    for (const rowId of this.#ofKind(rows, Jcid.tableRowNode)) {
      if (index === 1) await this.#separatorRow(columns);
      if (index > 0) await this.#note.push("\n");
      const cells = this.#cellsOf(rowId);
      await this.#note.push("| ");
      for (let column = 0; column < columns; column++) {
        if (column > 0) await this.#note.push(" | ");
        await this.#cell(cells.next().value, depth, path);
      }
      await this.#note.push(" |");
      index++;
    }
    if (rowCount === 1) await this.#separatorRow(columns);
  }
  async #separatorRow(columns) {
    await writeSeparatorRow(columns, (text) => this.#note.push(text));
  }
  /** The children of one kind, in order, holding an index rather than a list. */
  *#ofKind(children, jcid) {
    for (let index = 0; index < children.count; index++) {
      const id = children.at(index);
      if (this.#doc.object(id)?.jcid === jcid) yield id;
    }
  }
  #cellsOf(rowId) {
    const children = this.#children(this.#doc.viewOf(rowId), Property.elementChildNodes);
    return this.#ofKind(children, Jcid.tableCellNode);
  }
  /**
   * One cell, written straight into the row.
   *
   * `renderCell` builds the cell's text, collapses its whitespace, escapes
   * its pipes and trims it — four operations over a string that is as large
   * as the cell. None of them needs the string: collapsing a run of
   * whitespace to one space is a flag, escaping a pipe is a substitution of
   * one character for two, and trimming is the same flag held at both ends.
   * `CellText` is those three as one filter, so a cell holding a megabyte of
   * text costs a chunk of it.
   */
  async #cell(cellId, depth, path) {
    if (!cellId) return;
    const out = new CellText((text) => this.#note.push(text));
    const children = this.#children(this.#doc.viewOf(cellId), Property.elementChildNodes);
    await this.#writeChildren(children, depth, path, out);
  }
  /**
   * What a cell's children contribute, in order.
   *
   * `renderCell` collects a part per child, drops the empty ones and joins
   * the rest with a space. A part is dropped for being empty and not for
   * being blank, so what matters about a part is whether it produced any
   * character at all — which `CellText` tracks with a boolean, and which is
   * why the nesting can be flattened: joining non-empty parts with single
   * spaces gives the same string however the parts were grouped.
   */
  async #writeChildren(children, depth, path, out) {
    if (depth >= this.#options.maxPropertySetDepth) return;
    for (let index = 0; index < children.count; index++) {
      const object = this.#doc.object(children.at(index));
      if (!object) continue;
      switch (object.jcid) {
        case Jcid.richTextNode:
          out.beginPart();
          await this.#runs(this.#doc.view(object), out);
          out.endPart();
          break;
        case Jcid.outlineElementNode: {
          const view = this.#doc.view(object);
          const content = this.#children(view, Property.contentChildNodes);
          for (let at = 0; at < content.count; at++) {
            const contentId = content.at(at);
            const candidate = this.#doc.object(contentId);
            if (!candidate) continue;
            if (candidate.jcid === Jcid.inkContainer) {
              if (this.#ink(candidate)) break;
              continue;
            }
            if (HANDLED.has(candidate.jcid)) {
              await this.#writeChildren(one(contentId), depth + 1, path, out);
              break;
            }
          }
          await this.#writeChildren(
            this.#children(view, Property.elementChildNodes),
            depth + 1,
            path,
            out
          );
          break;
        }
        case Jcid.outlineNode:
        case Jcid.outlineGroup:
          await this.#writeChildren(
            this.#children(this.#doc.view(object), Property.elementChildNodes),
            depth + 1,
            path,
            out
          );
          break;
        case Jcid.imageNode:
          await out.part(await this.#imageLink(object) ?? "");
          break;
        case Jcid.embeddedFileNode:
          await out.part(await this.#embeddedFileLink(object) ?? "");
          break;
        case Jcid.inkContainer:
          this.#ink(object);
          break;
        case Jcid.tableNode:
          this.#page.onSkipped?.(this.#page.noteName, "not-representable");
          break;
        default:
          break;
      }
    }
  }
  // -- Assets -------------------------------------------------------------
  async #image(object) {
    const link = await this.#imageLink(object);
    if (link) {
      await this.#note.beginBlock(false);
      await this.#note.push(link);
    }
  }
  async #imageLink(object) {
    const view = this.#doc.view(object);
    const fileName = readString2(view, Property.imageFilename, this.#limits.maxValueChars, "An image file name", this.#limits.meter);
    const container = this.#container(view, Property.pictureContainer);
    const name = withExtension2(
      `${this.#page.noteName} image`,
      container?.extension ?? extensionFromName(fileName) ?? void 0
    );
    return this.#asset(container?.range, name, "", true);
  }
  async #embeddedFile(object) {
    const link = await this.#embeddedFileLink(object);
    if (link) {
      await this.#note.beginBlock(false);
      await this.#note.push(link);
    }
  }
  async #embeddedFileLink(object) {
    const view = this.#doc.view(object);
    const fileName = readString2(view, Property.embeddedFileName, this.#limits.maxValueChars, "An embedded file name", this.#limits.meter);
    const container = this.#container(view, Property.embeddedFileContainer);
    const name = withExtension2(fileName ?? "attachment", container?.extension);
    return this.#asset(container?.range, name, name, false);
  }
  /** The first container a property names, with its bytes and extension. */
  #container(view, propertyId) {
    for (const containerId of references(view, propertyId)) {
      const object = this.#doc.object(containerId);
      if (!object) continue;
      const containerView = this.#doc.view(object);
      return {
        extension: readString2(
          containerView,
          Property.fileDataExtension,
          this.#limits.maxValueChars,
          "A file extension",
          this.#limits.meter
        ) ?? object.fileExtension,
        range: this.#resolver.fileDataRangeOf(object)
      };
    }
    return void 0;
  }
  async #asset(range, name, label, embed) {
    if (!range || range.length === 0) {
      this.#page.onSkipped?.(name, "no-data");
      return void 0;
    }
    const attachment = await this.#assets.save(
      rangeStream(this.#resolver.window, range),
      name,
      this.#page.attachmentsDir,
      this.#page.linkPrefix
    );
    if (!attachment) {
      this.#page.onSkipped?.(name, "no-data");
      return void 0;
    }
    const target = encodeURI(attachment.path);
    return embed ? `![${label}](${target})` : `[${label}](${target})`;
  }
  // -- Ink ----------------------------------------------------------------
  /** Gather one ink container's strokes. Answers whether any were usable. */
  #ink(object) {
    const words = this.#inkInto(object, this.#strokes);
    if (words === void 0) return false;
    if (words !== "" && words !== this.#lastRecognized) {
      this.#spills.recognized.writeText(this.#recognizedCount === 0 ? words : ` ${words}`);
      this.#recognizedCount++;
      this.#lastRecognized = words;
    }
    return true;
  }
  /**
   * Decode a container's strokes into `strokes`, and answer its recognized
   * words — or nothing at all, if it drew nothing.
   *
   * Where the strokes go is the caller's choice because a title's ink is
   * decoded and discarded while a page's ink becomes a file.
   */
  #inkInto(object, strokes) {
    const view = this.#doc.view(object);
    const inkDataId = firstReference(view, Property.inkData);
    if (!inkDataId) return void 0;
    const inkData = this.#doc.object(inkDataId);
    if (inkData?.jcid !== Jcid.inkDataNode) return void 0;
    const scaleX = readFloat2(view, Property.inkScalingX) ?? 1;
    const scaleY = readFloat2(view, Property.inkScalingY) ?? 1;
    const inkView = this.#doc.view(inkData);
    let drawn = 0;
    let words = "";
    for (const strokeId of references(inkView, Property.inkStrokes)) {
      const stroke = this.#doc.object(strokeId);
      if (stroke?.jcid !== Jcid.inkStrokeNode) continue;
      if (!this.#stroke(stroke, scaleX, scaleY, strokes)) continue;
      drawn++;
      const recognized = this.#recognizedWord(strokeId);
      if (!recognized) continue;
      words = joinBounded(
        words,
        recognized,
        this.#limits.maxValueChars,
        "A drawing's recognized text",
        this.#limits.meter
      );
    }
    return drawn === 0 ? void 0 : words;
  }
  #stroke(object, scaleX, scaleY, strokes) {
    const view = this.#doc.view(object);
    const propertiesId = firstReference(view, Property.inkStrokeProperties);
    const properties = propertiesId ? this.#doc.object(propertiesId) : void 0;
    if (properties?.jcid !== Jcid.strokePropertiesNode) return false;
    const pathData = dataRange(view, Property.inkPath);
    if (!pathData) return false;
    const propertyView = this.#doc.view(properties);
    const dimensionRange = dataRange(propertyView, Property.inkDimensions);
    const dimensions = readInkDimensions(
      dimensionRange && dimensionRange.length > 0 ? new RangeReader(this.#resolver.window, dimensionRange) : void 0,
      InkDimensionId.x,
      InkDimensionId.y
    );
    if (dimensions.xIndex < 0 || dimensions.yIndex < 0) return false;
    const transparency = readUInt32Property2(propertyView, Property.inkTransparency) ?? 0;
    const width = Math.max(
      1e-6,
      (readFloat2(propertyView, Property.inkWidth) ?? 1) * Math.abs(scaleX) / NATIVE_UNITS_PER_HALF_INCH
    );
    const first = strokes.beginStroke();
    const drawn = decodeInkPath(
      new RangeReader(this.#resolver.window, pathData),
      this.#spills.inkCoordinates.chunkBytes,
      this.#spills.inkCoordinates,
      dimensions.count,
      dimensions.xIndex,
      dimensions.yIndex,
      Math.min(this.#options.maxInkPathValues, pathData.length * 8),
      (x, y) => strokes.pushPoint(
        x * scaleX / NATIVE_UNITS_PER_HALF_INCH * PIXELS_PER_INK_UNIT2,
        y * scaleY / NATIVE_UNITS_PER_HALF_INCH * PIXELS_PER_INK_UNIT2
      )
    );
    if (!drawn) return false;
    strokes.endStroke(
      first,
      decodeInkColor(readUInt32Property2(propertyView, Property.inkColor)),
      Math.max(1, width * PIXELS_PER_INK_UNIT2),
      1 - Math.min(255, transparency) / 255
    );
    return true;
  }
  async #writeCollectedInk() {
    if (!writeInkSvg(this.#strokes, this.#spills.inkDocument)) return;
    const attachment = await this.#assets.save(
      spoolStream(this.#spills.inkDocument),
      `${this.#page.noteName} - Ink.svg`,
      this.#page.attachmentsDir,
      this.#page.linkPrefix
    );
    if (attachment) {
      await this.#note.beginBlock(false);
      await this.#note.push(`![](${encodeURI(attachment.path)})`);
    } else this.#page.onSkipped?.(`${this.#page.noteName} - Ink.svg`, "no-data");
    if (this.#recognizedCount > 0) {
      await this.#note.beginBlock(false);
      for (const piece of this.#spills.recognized.text()) await this.#note.push(piece);
    }
  }
  // -- Recognition --------------------------------------------------------
  /**
   * Which handwritten word each stroke belongs to.
   *
   * The eager reader builds a map with one entry per stroke and keeps it for
   * the page. This writes the same entries into the store, keyed by the page's
   * slot, so the page's own resolution and its recognition share a lifetime.
   */
  #collectRecognition(pageView) {
    const rootId = firstReference(pageView, Property.pageRecognizedTextContainer);
    if (!rootId) return;
    this.#walkRecognition(rootId, 0);
  }
  #walkRecognition(id, depth) {
    if (depth > 8) return;
    const visited = this.#key.reset(StoreTag.recognitionVisited).u32(this.#recognitionSlot).extendedGuid(id).done();
    if (this.#store.has(visited)) return;
    this.#store.set(visited, EMPTY2);
    const object = this.#doc.object(id);
    if (!object) return;
    const view = this.#doc.view(object);
    if (object.jcid === Jcid.recognizedTextWord) {
      const word = this.#firstAlternative(view);
      const referenceRange = dataRange(view, Property.recognizedTextStrokeReferences);
      if (!word || !referenceRange) return;
      const reader = new RangeReader(this.#resolver.window, referenceRange);
      for (let offset = 0; offset + 20 <= referenceRange.length; offset += 20) {
        const stroke = { identifier: id.identifier, value: reader.u32(offset + 16) };
        const value = this.#value.reset().text(word).done();
        this.#store.set(
          this.#key.reset(StoreTag.recognition).u32(this.#recognitionSlot).extendedGuid(stroke).done(),
          value
        );
      }
      return;
    }
    const children = this.#children(view, Property.recognizedTextChildNodes);
    for (let index = 0; index < children.count; index++) {
      this.#walkRecognition(children.at(index), depth + 1);
    }
  }
  /** The first non-empty alternative of a recognized word. */
  #firstAlternative(view) {
    const range = dataRange(view, Property.recognizedText);
    if (!range || range.length < 2) return void 0;
    let current = "";
    for (const piece of utf16Text(view.window, range, 0, range.length >>> 1)) {
      for (const character of piece) {
        if (character !== "\0") {
          if (current.length >= this.#limits.maxValueChars) {
            throw overValueLimit(
              "A recognized handwriting alternative",
              current.length + 1,
              this.#limits.maxValueChars,
              "maxValueChars"
            );
          }
          current += character;
          continue;
        }
        if (current !== "") return current;
      }
    }
    this.#limits.meter?.value(current.length);
    return current !== "" ? current : void 0;
  }
  #recognizedWord(strokeId) {
    const stored = this.#store.get(
      this.#key.reset(StoreTag.recognition).u32(this.#recognitionSlot).extendedGuid(strokeId).done()
    );
    return stored ? new RecordReader(stored).text() : void 0;
  }
};
var HYPERLINK_WORD = "HYPERLINK";
var HANDLED = /* @__PURE__ */ new Set([
  Jcid.outlineNode,
  Jcid.outlineGroup,
  Jcid.outlineElementNode,
  Jcid.richTextNode,
  Jcid.imageNode,
  Jcid.embeddedFileNode,
  Jcid.tableNode,
  Jcid.inkContainer
]);
var CellText = class {
  constructor(emit) {
    this.emit = emit;
  }
  /** Whitespace seen and not yet emitted: interior until proven trailing. */
  #pendingSpace = false;
  /** Whether anything has survived the leading trim. */
  #seenContent = false;
  /** Whether the current part has produced a character. */
  #produced = false;
  /** Whether an earlier part did, which is what a separator needs. */
  #anyProduced = false;
  beginPart() {
    this.#produced = false;
  }
  endPart() {
    if (this.#produced) this.#anyProduced = true;
    this.#produced = false;
  }
  /** A part that arrives whole, such as an attachment link. */
  async part(text) {
    this.beginPart();
    await this.push(text);
    this.endPart();
  }
  async push(text) {
    if (text === "") return;
    if (!this.#produced) {
      this.#produced = true;
      if (this.#anyProduced) this.#pendingSpace = true;
    }
    let out = "";
    for (let index = 0; index < text.length; index++) {
      if (isWhitespace(text.charCodeAt(index))) {
        this.#pendingSpace = true;
        continue;
      }
      if (this.#pendingSpace) {
        this.#pendingSpace = false;
        if (this.#seenContent) out += " ";
      }
      this.#seenContent = true;
      out += text[index] === "|" ? "\\|" : text[index];
    }
    if (out !== "") await this.emit(out);
  }
};
var CoreWriter = class {
  constructor(style, resolveInternalLink, into, held) {
    this.style = style;
    this.resolveInternalLink = resolveInternalLink;
    this.into = into;
    this.#held = held;
    this.#held.clear();
  }
  /**
   * The run's leading whitespace before it opens, its trailing whitespace
   * after. Never both, since opening is what ends the first and starts the
   * second, so one region serves for the two of them.
   */
  #held;
  #opened = false;
  async push(piece) {
    let start = 0;
    if (!this.#opened) {
      while (start < piece.length && isWhitespace(piece.charCodeAt(start))) start++;
      this.#held.append(piece.slice(0, start));
      if (start === piece.length) return;
    }
    let end = piece.length;
    while (end > start && isWhitespace(piece.charCodeAt(end - 1))) end--;
    if (end > start) {
      if (!this.#opened) {
        await this.#emitHeld(false);
        await this.into.push(this.#prefix());
        this.#opened = true;
      } else if (!this.#held.isEmpty) {
        await this.#emitHeld(true);
      }
      await this.into.push(escapeInline2(piece.slice(start, end)));
    }
    if (end < piece.length) this.#held.append(piece.slice(end));
  }
  async finish() {
    if (!this.#opened) {
      await this.#emitHeld(false);
      return;
    }
    await this.into.push(this.#suffix());
    await this.#emitHeld(false);
  }
  /** The held whitespace, in the pieces the spill hands back. */
  async #emitHeld(escape) {
    if (this.#held.isEmpty) return;
    for (const piece of this.#held.pieces()) await this.into.push(escape ? escapeInline2(piece) : piece);
    this.#held.clear();
  }
  /** A maths run, whose core cannot be produced a piece at a time. */
  async whole(text) {
    const leading = text.match(/^\s*/)[0];
    const trailing = text.length > leading.length ? text.match(/\s*$/)[0] : "";
    const core = text.slice(leading.length, text.length - trailing.length);
    if (core === "") {
      if (text !== "") await this.into.push(text);
      return;
    }
    const latex = toLatex2(core);
    if (latex === "") return;
    await this.into.push(`${leading}$${latex}$${trailing}`);
  }
  /**
   * The markers that go before the core.
   *
   * `renderRun` wraps the core one style at a time, innermost first, so the
   * opening markers come out in the reverse of the order they are applied:
   * a bold link is `[**`, not `**[`.
   */
  #prefix() {
    let prefix = "";
    if (this.style.hyperlinkUrl) prefix += "[";
    if (this.style.strikethrough) prefix += "~~";
    if (this.style.italic) prefix += "*";
    if (this.style.bold) prefix += "**";
    if (this.style.underline) prefix += "<u>";
    if (this.style.subscript) prefix += "<sub>";
    if (this.style.superscript) prefix += "<sup>";
    if (this.style.highlight) prefix += highlightPrefix(this.style.highlight);
    return prefix;
  }
  #suffix() {
    let suffix = "";
    if (this.style.highlight) suffix += "==";
    if (this.style.superscript) suffix += "</sup>";
    if (this.style.subscript) suffix += "</sub>";
    if (this.style.underline) suffix += "</u>";
    if (this.style.bold) suffix += "**";
    if (this.style.italic) suffix += "*";
    if (this.style.strikethrough) suffix += "~~";
    if (this.style.hyperlinkUrl) suffix += `](${encodeURI(this.#target())})`;
    return suffix;
  }
  #target() {
    const pageTitle = internalPageTitle2(this.style.hyperlinkUrl);
    return pageTitle ? this.resolveInternalLink?.(pageTitle) ?? pageTitle : this.style.hyperlinkUrl;
  }
};
var BlockBody = class {
  #note;
  #line;
  #returns;
  #trimmer;
  #prefix;
  #indent;
  #open;
  #opened = false;
  #firstLine = true;
  constructor(note, spills, prefix, indent, open) {
    this.#note = note;
    this.#prefix = prefix;
    this.#indent = indent;
    this.#open = open;
    this.#line = spills.line;
    this.#line.clear();
    this.#trimmer = new Trimmer((piece) => this.#accept(piece), spills.paragraph);
    this.#returns = new CarriageReturnFilter((piece) => this.#trimmer.push(piece));
  }
  async push(text) {
    await this.#returns.push(text);
  }
  async finish() {
    await this.#returns.finish();
    await this.#trimmer.finish();
    if (this.#opened) await this.#flushLine();
    return this.#opened;
  }
  async #accept(piece) {
    if (!this.#opened) {
      await this.#open();
      await this.#note.push(this.#prefix);
      this.#opened = true;
    }
    let start = 0;
    for (; ; ) {
      const newline = piece.indexOf("\n", start);
      if (newline < 0) break;
      this.#line.append(piece.slice(start, newline));
      await this.#flushLine();
      start = newline + 1;
    }
    this.#line.append(piece.slice(start));
  }
  async #flushLine() {
    if (!this.#firstLine) await this.#note.push(HARD_BREAK + this.#indent);
    this.#firstLine = false;
    const { matched, whitespaceLength } = decideLineStart(this.#line.pieces());
    let emitted = 0;
    for (const piece of this.#line.pieces()) {
      if (matched && emitted <= whitespaceLength && emitted + piece.length >= whitespaceLength) {
        const at = whitespaceLength - emitted;
        await this.#note.push(`${piece.slice(0, at)}\\${piece.slice(at)}`);
      } else await this.#note.push(piece);
      emitted += piece.length;
    }
    if (matched && emitted < whitespaceLength) await this.#note.push("\\");
    this.#line.clear();
  }
};
function escapeInline2(text) {
  return text.replace(/[[\]`<]/g, "\\$&");
}
function scriptRuns2(text, glyphs, plain, marker) {
  const pattern = new RegExp(`[${glyphs}]+`, "g");
  return text.replace(pattern, (match) => {
    const decoded = [...match].map((character) => plain[glyphs.indexOf(character)]).join("");
    return `${marker}{${decoded}}`;
  });
}
function toLatex2(text) {
  const scripted = scriptRuns2(
    scriptRuns2(text, SUPERSCRIPTS2, SUPERSCRIPT_PLAIN2, "^"),
    SUBSCRIPTS2,
    SUBSCRIPT_PLAIN2,
    "_"
  );
  return scripted.normalize("NFKC").replace(INVISIBLE_MATH2, "").trim();
}
function internalPageTitle2(url) {
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
function highlightPrefix(color) {
  const match = color.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!match) return "==";
  const [red, green, blue] = match.slice(1).map((part) => parseInt(part, 16));
  let nearest = HIGHLIGHT_MARKERS2[0].marker;
  let best = Infinity;
  for (const { marker, inks } of HIGHLIGHT_MARKERS2) {
    for (const [inkRed, inkGreen, inkBlue] of inks) {
      const distance = (inkRed - red) ** 2 + (inkGreen - green) ** 2 + (inkBlue - blue) ** 2;
      if (distance < best) {
        best = distance;
        nearest = marker;
      }
    }
  }
  return `==${nearest}`;
}
function highlightColor2(color) {
  if (color === void 0 || (color & 4278190080) !== 0) return void 0;
  if ((color & 16777215) === 16777215) return void 0;
  const channel = (shift) => (color >> shift & 255).toString(16).padStart(2, "0");
  return `#${channel(0)}${channel(8)}${channel(16)}`;
}
function headingPrefix2(styleId) {
  const level = styleId?.match(/^h([1-6])$/i);
  return level ? "#".repeat(Number(level[1])) + " " : "";
}
function listPrefix2(list) {
  if (!list) return "";
  return "	".repeat(list.level) + (list.ordered ? "1. " : "- ");
}
function taskPrefix2(tags, list) {
  const task = tags?.find((tag) => tag.checkable);
  if (!task) return void 0;
  return "	".repeat(list?.level ?? 0) + (task.completed ? "- [x] " : "- [ ] ");
}
function calloutFor2(tags) {
  for (const tag of tags ?? []) {
    if (tag.checkable || tag.shape === void 0) continue;
    const type = CALLOUT_SHAPES2[tag.shape];
    if (type) return { type, title: tag.label };
  }
  return void 0;
}
function isCheckableShape2(shape) {
  if (shape >= 1 && shape <= 12) return true;
  if (shape === 28 || shape === 30 || shape === 32) return true;
  if (shape === 48 || shape === 50 || shape === 52) return true;
  if (shape === 69 || shape === 71 || shape === 73) return true;
  return shape >= 89 && shape <= 99;
}
function withExtension2(base, extension) {
  if (!extension) return base;
  if (extensionFromName(base)) return base;
  return base + (extension.startsWith(".") ? extension : `.${extension}`);
}

// src/stream/spills.ts
var Tag6 = {
  noteTrailing: 60,
  paragraphTrailing: 61,
  line: 62,
  inkPoints: 63,
  inkStrokes: 64,
  inkDocument: 65,
  recognized: 66,
  titleInkPoints: 67,
  titleInkStrokes: 68,
  runWhitespace: 69,
  inkCoordinates: 70
};
var POINT_BYTES2 = 16;
var COORDINATE_BYTES2 = 8;
var SpillSet = class {
  /** Whitespace held back by the note-level trim. */
  trailing;
  /** Whitespace held back by a paragraph's trim. */
  paragraph;
  /** One line of a paragraph, until its opening has been decided. */
  line;
  /**
   * The whitespace one text run opens or closes with.
   *
   * A run's emphasis markers go inside its whitespace, so the whitespace has
   * to be held until it is known whether a core follows it. One region does
   * for both ends: a run cannot be accumulating its leading whitespace and
   * its trailing whitespace at once, because reaching the second means the
   * first has already been written out.
   */
  runWhitespace;
  inkPoints;
  inkStrokes;
  /** The generated SVG, hashed from here and copied from here. */
  inkDocument;
  /** Recognized handwriting, joined into one block at the end of a page. */
  recognized;
  /**
   * Ink met while working out a page's title.
   *
   * The eager mapper decodes the title's elements and throws them away, so
   * ink in a title contributes its recognized words to the title and its
   * strokes to nothing. Decoding it somewhere separate is what keeps those
   * strokes out of the page's drawing.
   */
  titleInkPoints;
  titleInkStrokes;
  /**
   * One stroke's coordinates along whichever axis comes first in its path.
   *
   * An ink path stores its dimensions in blocks — every x, then every y — so
   * pairing them means having seen both, and the whole first block has to be
   * somewhere while the second is being read. Here, rather than in an array:
   * the block is as long as the file claims.
   *
   * Lasts one stroke. Reset at the start of each, so a page of ten thousand
   * strokes costs what one stroke costs.
   */
  inkCoordinates;
  constructor(store, budget = DEFAULT_SPILL_BUDGET, chunkBytes = DEFAULT_CHUNK_BYTES) {
    const pointChunk = Math.max(POINT_BYTES2, Math.floor(chunkBytes / POINT_BYTES2) * POINT_BYTES2);
    const coordinateChunk = Math.max(
      COORDINATE_BYTES2,
      Math.floor(chunkBytes / COORDINATE_BYTES2) * COORDINATE_BYTES2
    );
    this.trailing = new TextSpill(new ByteSpool(store, Tag6.noteTrailing, 0, chunkBytes), budget);
    this.paragraph = new TextSpill(new ByteSpool(store, Tag6.paragraphTrailing, 0, chunkBytes), budget);
    this.line = new TextSpill(new ByteSpool(store, Tag6.line, 0, chunkBytes), budget);
    this.runWhitespace = new TextSpill(new ByteSpool(store, Tag6.runWhitespace, 0, chunkBytes), budget);
    this.inkPoints = new ByteSpool(store, Tag6.inkPoints, 0, pointChunk);
    this.inkStrokes = new RecordSpool(store, Tag6.inkStrokes, 0);
    this.inkDocument = new ByteSpool(store, Tag6.inkDocument, 0, chunkBytes);
    this.recognized = new ByteSpool(store, Tag6.recognized, 0, chunkBytes);
    this.titleInkPoints = new ByteSpool(store, Tag6.titleInkPoints, 0, pointChunk);
    this.titleInkStrokes = new RecordSpool(store, Tag6.titleInkStrokes, 0);
    this.inkCoordinates = new ByteSpool(store, Tag6.inkCoordinates, 0, coordinateChunk);
  }
  /** Between notes: nothing survives a page boundary. */
  resetForNote() {
    this.trailing.clear();
    this.paragraph.clear();
    this.line.clear();
    this.runWhitespace.clear();
    this.inkPoints.reset();
    this.inkStrokes.reset();
    this.inkDocument.reset();
    this.recognized.reset();
    this.titleInkPoints.reset();
    this.titleInkStrokes.reset();
    this.inkCoordinates.reset();
  }
};

// src/stream/section.ts
var PROPERTY_TAG_BASE = 32;
var VISITED_PAGE_TAG = 59;
var EMPTY3 = new Uint8Array(0);
var noRelease = () => {
};
var StreamSection = class _StreamSection {
  name;
  colorArgb;
  index;
  #resolver;
  #store;
  /** Deregistrations for whoever is watching for a forced exit. */
  #releases;
  #spills;
  #renderer;
  #sectionSpace;
  #options;
  #limits;
  #noteBufferBytes;
  #key = new RecordWriter(32);
  /** Which walk of the pages is current, so repeats are per walk. */
  #walks = 0;
  constructor(index, store, resolver, sectionSpace, spills, renderer, limits, noteBufferBytes, releases = []) {
    this.#releases = releases;
    this.index = index;
    this.#limits = limits;
    this.#noteBufferBytes = noteBufferBytes;
    this.#store = store;
    this.#resolver = resolver;
    this.#sectionSpace = sectionSpace;
    this.#spills = spills;
    this.#renderer = renderer;
    this.#options = index.options;
    const metadata = sectionSpace.root(2);
    const metadataView = sectionSpace.properties(metadata);
    this.name = metadata?.jcid === Jcid.sectionMetadata ? readString2(
      metadataView,
      Property.sectionDisplayName,
      limits.maxValueChars,
      "A section display name",
      limits.meter
    ) ?? "" : "";
    this.colorArgb = metadata?.jcid === Jcid.sectionMetadata ? readUInt32Property2(metadataView, Property.notebookColor) : void 0;
  }
  /**
   * Index a section and resolve the space that describes it.
   *
   * Everything that fails because the artifact is not a section fails here,
   * before any page is reached, which is what lets a caller treat a section
   * that cannot be opened as one failure rather than as a failure per page.
   */
  static open(source, assets, options = {}) {
    const index = indexSection(source, options);
    const releaseIndex = options.onOpen?.("the section index", () => index.close()) ?? noRelease;
    try {
      const cacheBytes = options.conversionCacheBytes ?? options.cacheBytes ?? DEFAULT_SECTION_INDEX_OPTIONS.cacheBytes;
      const limits = limitsFor(
        options.valueReserveBytes ?? DEFAULT_VALUE_RESERVE_BYTES,
        // A watching account supplies the meter, so the ceilings and the
        // observations come from one place.
        { ...options.limits, meter: options.account?.meter ?? options.limits?.meter }
      );
      const store = new PagedKeyValueStore({
        pageSize: options.pageSize ?? DEFAULT_SECTION_INDEX_OPTIONS.pageSize,
        cacheBytes,
        bucketCount: options.bucketCount ?? DEFAULT_SECTION_INDEX_OPTIONS.bucketCount,
        tempDirectory: options.tempDirectory
      });
      const releaseStore = options.onOpen?.("the conversion store", () => store.close()) ?? noRelease;
      try {
        if (options.account) {
          options.account.addSectionCache(index, () => index.stats.cache.highWaterBytes);
          options.account.addSectionCache(store, () => store.cacheStats.highWaterBytes);
          options.account.addCopies(index, () => index.stats.cache.copyHighWaterBytes);
          options.account.addCopies(store, () => store.copyHighWaterBytes);
          options.account.setWindowBytes(index.stats.windowBytes);
        }
        const resolver = new SpaceResolver(index, index.window, store, PROPERTY_TAG_BASE);
        const sectionSpace = resolver.currentSpaceByRootJcid(Jcid.sectionNode);
        if (!sectionSpace) {
          throw new OneNoteFormatError(
            "ONENOTE_SECTION_OBJECT_SPACE",
            "No current section object space could be materialized."
          );
        }
        const root = sectionSpace.root(1);
        if (root?.jcid !== Jcid.sectionNode) {
          throw new OneNoteFormatError(
            "ONENOTE_SECTION_ROOT",
            "The current root object space does not resolve to a section node."
          );
        }
        const spills = new SpillSet(store, options.spillChars, options.chunkBytes);
        const renderer = new PageRenderer(resolver, store, spills, assets, index.options, limits);
        return new _StreamSection(
          index,
          store,
          resolver,
          sectionSpace,
          spills,
          renderer,
          limits,
          options.noteBufferBytes,
          [releaseStore, releaseIndex]
        );
      } catch (error) {
        releaseStore();
        throw error;
      }
    } catch (error) {
      releaseIndex();
      throw error;
    }
  }
  /**
   * A note writer over an open output file.
   *
   * The writer needs somewhere to hold back trailing whitespace, and that
   * somewhere is the section's own scratch space — so it comes from here
   * rather than from the caller, who would otherwise have to know that a
   * trimmer spills.
   */
  openNote(writer) {
    this.#spills.trailing.clear();
    return new NoteWriter(writer, this.#spills.trailing, this.#noteBufferBytes);
  }
  get stats() {
    const index = this.index.stats;
    const conversion = this.#store.cacheStats.residentBytes;
    return {
      index,
      conversionCacheBytes: conversion,
      residentBytes: index.residentBytes + conversion
    };
  }
  /**
   * Count the pages a conversion will attempt without resolving titles or
   * touching page bodies and assets.
   *
   * Exactness requires resolving each page space far enough to prove that it
   * has the same manifest and page node `pages()` requires, and to read its
   * deletion marker. Conversion resolves that metadata again on its second
   * walk; keeping it would make the heap grow with the section. The visited
   * identifiers for both walks stay in separate generations in the paged
   * store instead.
   *
   * `undefined` means cancellation was requested. Yielding once per candidate
   * keeps a large pre-count interruptible even though store reads are
   * synchronous.
   */
  async countPages(includeDeleted = false, isCancelled) {
    let count = 0;
    for (const spaceId of this.#pageSpaceIds()) {
      await new Promise((resolve) => {
        setImmediate(resolve);
      });
      if (isCancelled?.()) return void 0;
      const deleted = this.#pageDeletionState(spaceId);
      if (deleted !== void 0 && (includeDeleted || !deleted)) count++;
    }
    return count;
  }
  /**
   * The section's pages, one resolved at a time.
   *
   * Consuming this lazily is the point: the sequence holds a page's object
   * space only while its element is current, so a section with ten thousand
   * pages costs what its largest page costs, not what all of them do.
   */
  *pages() {
    for (const spaceId of this.#pageSpaceIds()) {
      const page = this.#page(spaceId);
      if (page) yield page;
    }
  }
  /**
   * Page-space identifiers in section order, unique within this traversal.
   *
   * Every call owns a generation in the disk-backed visited namespace. That
   * makes the metadata pre-count and conversion independent without an
   * unbounded heap Set or a store-wide reset.
   */
  *#pageSpaceIds() {
    const root = this.#sectionSpace.root(1);
    const rootView = this.#sectionSpace.properties(root);
    const walk2 = ++this.#walks;
    let visited = 0;
    for (const seriesId of references(rootView, Property.elementChildNodes)) {
      const series = this.#sectionSpace.object(seriesId);
      if (series?.jcid !== Jcid.pageSeriesNode) continue;
      const seriesView = this.#sectionSpace.properties(series);
      for (const spaceId of references(seriesView, Property.childGraphSpaceElementNodes)) {
        if (visited >= this.#options.maxPageGraphNodes) return;
        const key = this.#key.reset(VISITED_PAGE_TAG).u32(walk2).extendedGuid(spaceId).done();
        if (this.#store.has(key)) continue;
        this.#store.set(key, EMPTY3);
        visited++;
        yield spaceId;
      }
    }
  }
  close() {
    for (const release of this.#releases) release();
    this.#store.close();
    this.index.close();
  }
  /**
   * One page's metadata, and a way to render it.
   *
   * The space is resolved here rather than in `render` because the title and
   * the level decide the note's name and its folder, and both are needed
   * before a byte is written. What that costs is the page's object map, which
   * is in the store; the page's content is still untouched.
   */
  #page(spaceId) {
    const space = this.#resolver.tryGetSpace(spaceId);
    if (!space) return void 0;
    const manifest = space.root(1);
    if (manifest?.jcid !== Jcid.pageManifestNode) return void 0;
    const pageNode = this.#pageNodeOf(space, manifest);
    if (!pageNode) return void 0;
    const metadata = space.properties(space.root(2));
    const revisionMetadata = space.properties(space.root(4));
    const pageView = space.properties(pageNode);
    let title = readString2(
      metadata,
      Property.cachedTitleString,
      this.#limits.maxValueChars,
      "A page title",
      this.#limits.meter
    ) ?? readString2(
      pageView,
      Property.cachedTitleStringFromPage,
      this.#limits.maxValueChars,
      "A page title",
      this.#limits.meter
    ) ?? "";
    if (title.trim() === "") {
      this.#spills.resetForNote();
      title = this.#renderer.collectTitle(space, pageNode);
    }
    return {
      id: keyOf2(spaceId),
      title,
      level: Math.max(0, (readUInt32Property2(metadata, Property.pageLevel) ?? 1) - 1),
      createdUtc: readFileTime2(metadata, Property.topologyCreationTimestamp),
      lastModifiedUtc: readFileTime2(revisionMetadata, Property.lastModifiedTimestamp) ?? readTime322(pageView, Property.lastModifiedTime),
      isConflictPage: readBoolean2(metadata, Property.isConflictPage) ?? space.root(2)?.jcid === Jcid.conflictPageMetadata,
      isDeleted: dataRange(metadata, Property.isDeletedGraphSpaceContent) !== void 0,
      render: async (note, options) => {
        this.#spills.resetForNote();
        await this.#renderer.render(space, pageNode, note, options);
      }
    };
  }
  /**
   * The least metadata needed to decide whether `#page` would yield and
   * whether conversion filters it. `undefined` means this is not a page.
   */
  #pageDeletionState(spaceId) {
    const space = this.#resolver.tryGetSpace(spaceId);
    if (!space) return void 0;
    const manifest = space.root(1);
    if (manifest?.jcid !== Jcid.pageManifestNode || !this.#pageNodeOf(space, manifest)) return void 0;
    const metadata = space.properties(space.root(2));
    return dataRange(metadata, Property.isDeletedGraphSpaceContent) !== void 0;
  }
  #pageNodeOf(space, manifest) {
    const view = space.properties(manifest);
    for (const childId of references(view, Property.contentChildNodes)) {
      const candidate = space.object(childId);
      if (candidate?.jcid === Jcid.pageNode) return candidate;
    }
    return void 0;
  }
};
function keyOf2(id) {
  return `${id.identifier}:${id.value}`;
}

// src/stream/sink.ts
function isChunkedSink(sink) {
  return typeof sink.open === "function";
}
var BufferedChunkWriter = class {
  #sink;
  #path;
  #pieces = [];
  #length = 0;
  #closed = false;
  constructor(sink, path) {
    this.#sink = sink;
    this.#path = path;
  }
  async write(chunk) {
    if (this.#closed) throw new Error(`${this.#path} was written to after it was closed.`);
    if (chunk.byteLength === 0) return;
    this.#pieces.push(chunk.slice());
    this.#length += chunk.byteLength;
  }
  async close() {
    if (this.#closed) return;
    this.#closed = true;
    const whole = new Uint8Array(this.#length);
    let at = 0;
    for (const piece of this.#pieces) {
      whole.set(piece, at);
      at += piece.byteLength;
    }
    this.#pieces.length = 0;
    await this.#sink.write(this.#path, whole);
  }
  async abort() {
    this.#closed = true;
    this.#pieces.length = 0;
  }
};
function asChunkedSink(sink) {
  if (isChunkedSink(sink)) return sink;
  return {
    write: (path, data) => sink.write(path, data),
    open: async (path) => new BufferedChunkWriter(sink, path)
  };
}

// src/stream/workspace.ts
var Tag7 = {
  claimed: 1,
  content: 2,
  note: 3,
  attachment: 4,
  skipped: 5,
  failure: 6,
  subpageLevel: 7,
  input: 8,
  group: 9
};
var EMPTY4 = new Uint8Array(0);
function codeOf(error) {
  if (error instanceof OneNoteFormatError) return error.code;
  const code = error?.code;
  return typeof code === "string" ? code : void 0;
}
var StreamWorkspace = class {
  store;
  #key = new RecordWriter(256);
  #value = new RecordWriter(256);
  #owned;
  #notes = 0;
  #attachments = 0;
  #skipped = 0;
  #errors = 0;
  cancelled = false;
  /** Distinguishes one section's subpage stack from the next one's. */
  #stacks = 0;
  #inputs = 0;
  #groups = 0;
  constructor(store, options) {
    this.#owned = store === void 0;
    this.store = store ?? new PagedKeyValueStore(options);
  }
  // -- Names --------------------------------------------------------------
  /**
   * Reserve a name in a folder, adding ` 1`, ` 2`, … until one is free.
   *
   * Case-insensitive, because macOS and Windows filesystems are, and reserved
   * as it is handed out rather than by looking at the disk — so a dry run and
   * a real run agree, and two pages in one batch cannot both win a name.
   */
  claim(folder, fileName) {
    const chosen = availableFileName(fileName, (candidate) => this.isClaimed(folder, candidate));
    this.store.set(this.#claimKey(folder, chosen), EMPTY4);
    return chosen;
  }
  isClaimed(folder, fileName) {
    return this.store.has(this.#claimKey(folder, fileName));
  }
  #claimKey(folder, fileName) {
    return this.#key.reset(Tag7.claimed).text(folder).text(fileName.toLowerCase()).done();
  }
  // -- Content -------------------------------------------------------------
  /** The attachment already written for these bytes in this folder. */
  writtenFor(folder, digest) {
    const stored = this.store.get(this.#contentKey(folder, digest));
    if (!stored) return void 0;
    const reader = new RecordReader(stored);
    return { path: reader.text(), name: reader.text() };
  }
  rememberContent(folder, digest, attachment) {
    this.store.set(
      this.#contentKey(folder, digest),
      this.#value.reset().text(attachment.path).text(attachment.name).done()
    );
  }
  #contentKey(folder, digest) {
    return this.#key.reset(Tag7.content).text(folder).text(digest).done();
  }
  // -- Subpage nesting -------------------------------------------------------
  /**
   * A place to keep one folder per level of subpage nesting.
   *
   * A page's own folder is only named once one of its subpages arrives, so
   * the walk carries the folder it would use at each level it has reached. A
   * page can only ever be one level deeper than the page before it, but that
   * still means a section whose pages nest all the way down carries a folder
   * per page — so they are carried here instead of in an array.
   */
  openSubpageLevels(root) {
    return new SubpageLevels(this.store, ++this.#stacks, root);
  }
  // -- Inputs --------------------------------------------------------------
  /**
   * A discovered input, appended to the store rather than to an array.
   *
   * Naming a folder of ten thousand sections should not cost ten thousand
   * paths in the heap before the first one is opened. The paths go here as
   * they are found and come back out with `inputs()`.
   */
  recordInput(path) {
    this.store.set(
      this.#key.reset(Tag7.input).u32(this.#inputs++).done(),
      this.#value.reset().text(path).done()
    );
  }
  get inputCount() {
    return this.#inputs;
  }
  *inputs() {
    for (let index = 0; index < this.#inputs; index++) {
      yield new RecordReader(this.#read(Tag7.input, index)).text();
    }
  }
  // -- Report --------------------------------------------------------------
  get summary() {
    return {
      noteCount: this.#notes,
      attachmentCount: this.#attachments,
      skippedCount: this.#skipped,
      errorCount: this.#errors,
      cancelled: this.cancelled
    };
  }
  /** Where each report stands now, for taking either side of an input. */
  get marks() {
    return {
      notes: this.#notes,
      attachments: this.#attachments,
      skipped: this.#skipped,
      errors: this.#errors
    };
  }
  /**
   * One input's slice of the report, on disk beside the records it bounds.
   *
   * A group is four counts and a path, so an array of them is small next to
   * a note — but it is still one entry per input, and the claim is about the
   * converter's memory rather than about which parts of it are small.
   */
  recordGroup(group) {
    this.store.set(
      this.#key.reset(Tag7.group).u32(this.#groups++).done(),
      this.#value.reset().text(group.input).u32(group.from.notes).u32(group.from.attachments).u32(group.from.skipped).u32(group.from.errors).u32(group.to.notes).u32(group.to.attachments).u32(group.to.skipped).u32(group.to.errors).u8(group.cancelled ? 1 : 0).done()
    );
  }
  get groupCount() {
    return this.#groups;
  }
  *groups() {
    for (let index = 0; index < this.#groups; index++) {
      const reader = new RecordReader(this.#read(Tag7.group, index));
      yield {
        input: reader.text(),
        from: {
          notes: reader.u32(),
          attachments: reader.u32(),
          skipped: reader.u32(),
          errors: reader.u32()
        },
        to: {
          notes: reader.u32(),
          attachments: reader.u32(),
          skipped: reader.u32(),
          errors: reader.u32()
        },
        cancelled: reader.u8() === 1
      };
    }
  }
  recordNote(path) {
    this.store.set(
      this.#key.reset(Tag7.note).u32(this.#notes++).done(),
      this.#value.reset().text(path).done()
    );
  }
  recordAttachment(path) {
    this.store.set(
      this.#key.reset(Tag7.attachment).u32(this.#attachments++).done(),
      this.#value.reset().text(path).done()
    );
  }
  recordSkipped(page, item, reason) {
    this.store.set(
      this.#key.reset(Tag7.skipped).u32(this.#skipped++).done(),
      this.#value.reset().text(page).text(item).text(reason).done()
    );
  }
  recordFailure(name, error) {
    const failure2 = {
      name,
      kind: error instanceof OneNoteFormatError ? error.kind : "unknown",
      // A `PagedStoreError`, a `ByteSourceError` and a `BudgetError` all
      // carry a code and none of them is a format error, so the code is
      // taken from whatever has one. It is what a caller looks up advice
      // by, and a store that ran out of temporary space deserves advice
      // as much as a malformed section does.
      code: codeOf(error),
      message: error instanceof Error ? error.message : String(error)
    };
    this.store.set(
      this.#key.reset(Tag7.failure).u32(this.#errors++).done(),
      this.#value.reset().text(failure2.name).text(failure2.kind).optionalText(failure2.code).text(failure2.message).done()
    );
  }
  /**
   * The records, in the order they happened, over any half-open range.
   *
   * Defaulting to the whole run keeps the batch-wide reading these had
   * before; passing a range is how one input's share is read back without a
   * per-input structure existing anywhere.
   */
  *notes(from = 0, to = this.#notes) {
    for (let index = from; index < to; index++) {
      yield new RecordReader(this.#read(Tag7.note, index)).text();
    }
  }
  *attachments(from = 0, to = this.#attachments) {
    for (let index = from; index < to; index++) {
      yield new RecordReader(this.#read(Tag7.attachment, index)).text();
    }
  }
  *skips(from = 0, to = this.#skipped) {
    for (let index = from; index < to; index++) {
      const reader = new RecordReader(this.#read(Tag7.skipped, index));
      yield { page: reader.text(), item: reader.text(), reason: reader.text() };
    }
  }
  *failures(from = 0, to = this.#errors) {
    for (let index = from; index < to; index++) {
      const reader = new RecordReader(this.#read(Tag7.failure, index));
      const name = reader.text();
      const kind = reader.text();
      const code = reader.optionalText();
      yield { name, kind, code, message: reader.text() };
    }
  }
  #read(tag, index) {
    return this.store.get(this.#key.reset(tag).u32(index).done());
  }
  close() {
    if (this.#owned) this.store.close();
  }
};
var SubpageLevels = class {
  #store;
  #key = new RecordWriter(32);
  #value = new RecordWriter(256);
  #stack;
  #depth = 0;
  constructor(store, stack, root) {
    this.#store = store;
    this.#stack = stack;
    this.set(0, root);
  }
  /** The deepest level that has a folder, which is what a page's level clamps to. */
  get depth() {
    return this.#depth;
  }
  at(level) {
    const stored = this.#store.get(this.#keyFor(level));
    if (!stored) throw new RangeError(`No folder is recorded for subpage level ${level}.`);
    return new RecordReader(stored).text();
  }
  set(level, folder) {
    this.#store.set(this.#keyFor(level), this.#value.reset().text(folder).done());
    this.#depth = level;
  }
  /** Forget everything below `level`, as `levels.length = level + 1` did. */
  truncate(level) {
    this.#depth = level;
  }
  #keyFor(level) {
    return this.#key.reset(Tag7.subpageLevel).u32(this.#stack).u32(level).done();
  }
};

// src/stream/convert.ts
var DEFAULTS2 = {
  attachmentsDir: "attachments",
  writeAttachments: true,
  includeDeleted: false,
  nestSubpages: true,
  frontmatter: true
};
async function convertSectionStream(source, fileName, sink, options = {}) {
  return convert([{ source, title: titleOf2(fileName), groups: [] }], fileName, sink, options);
}
async function convert(sources, fileName, sink, options) {
  const opts = { ...DEFAULTS2, ...options };
  const workspace = options.workspace ?? new StreamWorkspace();
  const chunked = asChunkedSink(sink);
  const assets = new AssetWriter(chunked, workspace, { writeAttachments: opts.writeAttachments });
  const notebook = opts.notebookName ?? (sources.length > 1 || sources[0]?.groups.length ? baseName2(fileName) : void 0);
  try {
    let index = 0;
    for (const entry of sources) {
      if (opts.isCancelled?.()) {
        workspace.cancelled = true;
        break;
      }
      opts.onProgress?.({
        kind: "section",
        name: entry.title,
        index: ++index,
        total: sources.length
      });
      await convertOne(entry, { opts, workspace, chunked, assets, notebook });
    }
    return workspace.summary;
  } finally {
    if (!options.workspace) workspace.close();
  }
}
async function convertOne(entry, ctx) {
  const { opts, workspace } = ctx;
  let section;
  try {
    section = StreamSection.open(entry.source, ctx.assets, {
      reader: opts.readerOptions ?? DEFAULT_READER_OPTIONS,
      ...opts.storage
    });
  } catch (error) {
    if (isCancellation(error)) workspace.cancelled = true;
    else workspace.recordFailure(entry.title, error);
    return;
  }
  try {
    const groups = entry.groups.map((group) => sanitizeFileName(group));
    const parent = join3(ctx.notebook && sanitizeFileName(ctx.notebook), ...groups);
    const sectionName = workspace.claim(parent, sanitizeFileName(section.name || entry.title));
    await convertPages(section, join3(parent, sectionName), entry, ctx);
  } catch (error) {
    if (isCancellation(error)) workspace.cancelled = true;
    else workspace.recordFailure(entry.title, error);
  } finally {
    section.close();
    opts.storage?.account?.release();
  }
}
async function convertPages(section, sectionDir, entry, ctx) {
  const { opts, workspace } = ctx;
  const label = section.name || entry.title;
  const total = await section.countPages(opts.includeDeleted, opts.isCancelled);
  if (total === void 0) {
    workspace.cancelled = true;
    return;
  }
  const levels = workspace.openSubpageLevels(sectionDir);
  let done = 0;
  for (const page of section.pages()) {
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    if (opts.isCancelled?.()) {
      workspace.cancelled = true;
      return;
    }
    if (page.isDeleted && !opts.includeDeleted) continue;
    const depth = opts.nestSubpages ? Math.min(page.level, levels.depth) : 0;
    levels.truncate(depth);
    const target = levels.at(depth);
    const noteName = workspace.claim(target, `${sanitizeFileName(page.title)}.md`);
    const notePath = join3(target, noteName);
    const stem = noteName.replace(/\.md$/, "");
    try {
      await writeNote(section, page, notePath, stem, target, label, entry, ctx);
      workspace.recordNote(notePath);
    } catch (error) {
      if (isCancellation(error)) {
        workspace.cancelled = true;
        return;
      }
      workspace.recordFailure(stem, error);
    }
    opts.onProgress?.({ kind: "note", name: stem, index: ++done, total });
    levels.set(depth + 1, join3(target, stem));
  }
}
async function writeNote(section, page, notePath, stem, target, label, entry, ctx) {
  const { opts, workspace } = ctx;
  const writer = await ctx.chunked.open(notePath);
  const note = section.openNote(writer);
  try {
    if (opts.frontmatter) {
      await note.raw(frontMatterFor2(page, label, ctx.notebook, entry.groups));
    }
    const render = {
      attachmentsDir: join3(target, opts.attachmentsDir),
      linkPrefix: opts.attachmentsDir,
      noteName: stem,
      resolveInternalLink: (linked) => sanitizeFileName(linked),
      onSkipped: (item, reason) => workspace.recordSkipped(stem, item, reason),
      isCancelled: opts.isCancelled
    };
    await page.render(note, render);
    await note.finish();
    await writer.close();
  } catch (error) {
    await writer.abort?.();
    throw error;
  }
}
function scalar2(value) {
  return JSON.stringify(value);
}
function frontMatterFor2(page, section, notebook, groups) {
  const lines = [
    "---",
    `title: ${scalar2(page.title)}`,
    `source: onenote`,
    `onenote-id: ${scalar2(page.id)}`,
    `section: ${scalar2(section)}`
  ];
  if (notebook) lines.push(`notebook: ${scalar2(notebook)}`);
  if (groups.length > 0) lines.push(`section-group: ${scalar2(groups.join("/"))}`);
  if (page.createdUtc) lines.push(`created: ${page.createdUtc.toISOString()}`);
  if (page.lastModifiedUtc) lines.push(`updated: ${page.lastModifiedUtc.toISOString()}`);
  if (page.isConflictPage) lines.push("conflict: true");
  if (page.isDeleted) lines.push("deleted: true");
  lines.push("---", "");
  return lines.join("\n");
}
function titleOf2(name) {
  return name.replace(/^.*[\\/]/, "").replace(/\.one$/i, "");
}
function baseName2(fileName) {
  return fileName.replace(/^.*[\\/]/, "").replace(/\.(one|onepkg|onex)$/i, "");
}

// src/stream/run.ts
var ARCHIVES = {
  ".onepkg": "a Cabinet archive of sections",
  ".onex": "a compound file holding a notebook"
};
var SIGNATURES = [
  ["a Cabinet archive of sections", [77, 83, 67, 70]],
  ["a compound file holding a notebook", [208, 207, 17, 224, 161, 177, 26, 225]]
];
var BoundedScopeError = class extends Error {
  code = "ONE2MD_BOUNDED_SCOPE";
  constructor(message) {
    super(message);
    this.name = "BoundedScopeError";
  }
};
function archiveKind(path) {
  return ARCHIVES[nodePath3.extname(path).toLowerCase()];
}
function boundedScopeError(path, kind = archiveKind(path)) {
  return new BoundedScopeError(
    `${nodePath3.basename(path)} is ${kind ?? "not a loose section"}, and the bounded path converts loose .one sections only. Convert it without --memory-budget, or extract its sections first and convert those.`
  );
}
var Closers = class {
  #stack = [];
  add(what, close) {
    const entry = { what, close };
    this.#stack.push(entry);
    return () => {
      const at = this.#stack.indexOf(entry);
      if (at >= 0) this.#stack.splice(at, 1);
      guard(entry);
    };
  }
  /** Release everything still open. Safe to call more than once. */
  closeAll() {
    while (this.#stack.length > 0) guard(this.#stack.pop());
  }
};
function guard(entry) {
  try {
    entry.close();
  } catch (error) {
    process.stderr.write(
      `  ! could not release ${entry.what}: ${error instanceof Error ? error.message : String(error)}
`
    );
  }
}
async function runBounded(options, closers) {
  const workspace = new StreamWorkspace(void 0, workspaceStorageFor(options.budget));
  closers.add("the workspace store", () => workspace.close());
  if (options.account) {
    options.account.declare(
      fixedBufferBytes(options.budget),
      options.budget.valueReserveBytes,
      options.budget.totalBytes
    );
    options.account.setMeter(new ValueMeter());
    options.account.addCache(workspace, () => workspace.store.cacheStats.highWaterBytes);
    options.account.addCopies(workspace, () => workspace.store.copyHighWaterBytes);
  }
  for (const file of options.files) {
    if (options.isCancelled?.()) {
      workspace.cancelled = true;
      break;
    }
    workspace.recordInput(file);
    options.onStart?.(file);
    const from = workspace.marks;
    await convertOne2(file, options, workspace, closers);
    const group = {
      input: file,
      from,
      to: workspace.marks,
      cancelled: workspace.cancelled
    };
    workspace.recordGroup(group);
    options.onInput?.(group);
  }
  const summary = workspace.summary;
  return {
    workspace,
    groupCount: workspace.groupCount,
    noteCount: summary.noteCount,
    attachmentCount: summary.attachmentCount,
    failed: summary.errorCount > 0,
    cancelled: workspace.cancelled
  };
}
async function convertOne2(file, options, workspace, closers) {
  const name = nodePath3.basename(file);
  if (archiveKind(file)) {
    workspace.recordFailure(name, boundedScopeError(file));
    return;
  }
  let fd;
  try {
    fd = nodeFs4.openSync(file, "r");
  } catch (error) {
    workspace.recordFailure(name, error);
    return;
  }
  const release = closers.add(`the descriptor for ${name}`, () => nodeFs4.closeSync(fd));
  let releaseSink = () => {
  };
  try {
    const source = new FileDescriptorByteSource(fd);
    const container = containerKind(source);
    if (container) {
      workspace.recordFailure(name, boundedScopeError(file, container));
      return;
    }
    const sink = options.dryRun ? new NullSink() : new FsSink(options.out, options.overwrite);
    if (sink instanceof FsSink) {
      releaseSink = closers.add(`the open files of ${name}`, () => sink.abortAll());
    }
    await convertSectionStream(source, name, sink, {
      ...options.convert,
      readerOptions: options.readerOptions,
      storage: {
        ...sectionStorageFor(options.budget),
        account: options.account,
        // So a forced exit removes this section's temporary stores.
        // They are closed by the section either way; this is only for
        // the exit that never reaches the closing.
        onOpen: (what, close) => closers.add(`${what} for ${name}`, close)
      },
      workspace,
      onProgress: options.onProgress,
      isCancelled: options.isCancelled
    });
  } catch (error) {
    workspace.recordFailure(name, error);
  } finally {
    releaseSink();
    release();
  }
}
function containerKind(source) {
  for (const [kind, signature] of SIGNATURES) {
    if (source.size < signature.length) continue;
    const magic = source.read(0, signature.length);
    if (signature.every((byte, index) => magic[index] === byte)) return kind;
  }
  return void 0;
}
function listBounded(file) {
  if (archiveKind(file)) throw boundedScopeError(file);
  const fd = nodeFs4.openSync(file, "r");
  try {
    const container = containerKind(new FileDescriptorByteSource(fd));
    if (container) throw boundedScopeError(file, container);
  } finally {
    nodeFs4.closeSync(fd);
  }
  const name = nodePath3.basename(file);
  return { name, title: name.replace(/\.one$/i, ""), groups: [] };
}
function checkTempDirectory(path) {
  try {
    nodeFs4.mkdirSync(path, { recursive: true });
    nodeFs4.accessSync(path, nodeFs4.constants.W_OK);
  } catch (error) {
    throw new OneNoteFormatError(
      "ONE2MD_TEMP_DIR_LIMIT",
      `The temporary directory ${path} cannot be written to: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

// src/cli.ts
var USAGE = `one2md \u2014 convert OneNote .one / .onepkg files to Markdown

Usage:
  one2md <input...> [options]

Inputs may be .one or .onepkg files, or folders to search for them.

Options:
  -o, --out <dir>        Where to write (default: ./out)
      --list             List the sections in each input and exit
      --sections <a,b>   Only convert these sections of a .onepkg (by entry name)
      --notebook <name>  Name the notebook these sections came from
      --dry-run          Report what would be written without writing it
      --overwrite        Replace existing files instead of failing on them
      --no-attachments   Leave images and embedded files out
      --attachments <d>  Folder name for assets beside a note (default: attachments)
      --no-frontmatter   Omit the YAML header
      --no-nest          Write subpages beside their parent, not in a folder
      --include-deleted  Include pages still in OneNote's recycle bin
      --json             Emit a machine-readable report on stdout
      --max-entry-bytes <n>     Largest single section, e.g. 512M (default 512M)
      --max-expanded-bytes <n>  Largest expanded archive, e.g. 4G (default 2G)
      --max-entries <n>         Most entries in an archive (default 4096)
      --max-objects <n>         Most objects per section (default 1000000)
      --max-asset-bytes <n>     Largest embedded file in a section, e.g. 512M
                                (default 64M). Also raises the section's
                                total-asset ceiling to at least this size.
      --max-total-asset-bytes <n>
                                Sum of embedded files in one section
                                (default 256M)
      --memory-budget <size>    Convert with a hard ceiling on the converter's
                                own buffers, e.g. 8M. Selects the bounded path,
                                which reads loose .one sections through a file
                                descriptor and never holds one whole. Minimum
                                1M. Excludes the fixed Node runtime overhead.
      --temp-dir <path>         Where the bounded path creates its private
                                temporary directories. Implies the bounded path.
  -q, --quiet            Only report failures
  -h, --help             Show this message

Exit codes:
  0    every input converted
  1    at least one input or section failed
  2    bad usage
  130  cancelled by SIGINT or SIGTERM before finishing
`;
var UsageError = class extends Error {
};
function parseSize(flag, value) {
  const match = /^(\d+(?:\.\d+)?)\s*([kmg]?)b?$/i.exec(value.trim());
  if (!match) throw new UsageError(`${flag} expects a size such as 512M or 4G, not "${value}"`);
  const scale = { "": 1, k: 1024, m: 1024 * 1024, g: 1024 * 1024 * 1024 }[match[2].toLowerCase()];
  return Math.floor(Number(match[1]) * scale);
}
function parseCount(flag, value) {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1) throw new UsageError(`${flag} expects a whole number, not "${value}"`);
  return count;
}
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
      case "--notebook":
        options.notebook = next(arg, argv[++i]);
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
      case "--max-entry-bytes":
        options.maxEntryBytes = parseSize(arg, next(arg, argv[++i]));
        break;
      case "--max-expanded-bytes":
        options.maxExpandedBytes = parseSize(arg, next(arg, argv[++i]));
        break;
      case "--max-entries":
        options.maxEntries = parseCount(arg, next(arg, argv[++i]));
        break;
      case "--max-objects":
        options.maxObjects = parseCount(arg, next(arg, argv[++i]));
        break;
      case "--max-asset-bytes":
        options.maxAssetBytes = parseSize(arg, next(arg, argv[++i]));
        break;
      case "--max-total-asset-bytes":
        options.maxTotalAssetBytes = parseSize(arg, next(arg, argv[++i]));
        break;
      case "--memory-budget":
        options.memoryBudget = parseSize(arg, next(arg, argv[++i]));
        break;
      case "--temp-dir":
        options.tempDir = next(arg, argv[++i]);
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
function readerOptionsFrom(options) {
  const maxAssetBytes = options.maxAssetBytes ?? DEFAULT_READER_OPTIONS.maxAssetBytes;
  const maxTotalAssetBytes = options.maxTotalAssetBytes ?? Math.max(DEFAULT_READER_OPTIONS.maxTotalAssetBytes, maxAssetBytes);
  if (maxTotalAssetBytes < maxAssetBytes) {
    throw new UsageError("--max-total-asset-bytes must be at least --max-asset-bytes");
  }
  return {
    ...DEFAULT_READER_OPTIONS,
    ...options.maxObjects !== void 0 && { maxObjects: options.maxObjects },
    maxAssetBytes,
    maxTotalAssetBytes
  };
}
var EXTENSIONS = /\.(one|onepkg|onex)$/i;
function collect(inputs) {
  return [...discover(inputs)];
}
function* discover(inputs) {
  function* walk2(current) {
    if (!nodeFs5.statSync(current).isDirectory()) {
      yield current;
      return;
    }
    for (const entry of sortedEntries(current)) {
      const full = nodePath4.join(current, entry.name);
      if (entry.isDirectory) yield* walk2(full);
      else if (EXTENSIONS.test(entry.name)) yield full;
    }
  }
  for (const input of inputs) {
    if (!nodeFs5.existsSync(input)) throw new UsageError(`No such file or folder: ${input}`);
    yield* walk2(input);
  }
}
function* sortedEntries(directory) {
  let previous;
  for (; ; ) {
    let next;
    const dir = nodeFs5.opendirSync(directory);
    try {
      for (let entry = dir.readSync(); entry !== null; entry = dir.readSync()) {
        if (previous !== void 0 && compareNames(entry.name, previous) <= 0) continue;
        if (next === void 0 || compareNames(entry.name, next.name) < 0) {
          next = { name: entry.name, isDirectory: entry.isDirectory() };
        }
      }
    } finally {
      dir.closeSync();
    }
    if (next === void 0) return;
    previous = next.name;
    yield next;
  }
}
function compareNames(left, right) {
  const byLocale = left.localeCompare(right);
  if (byLocale !== 0) return byLocale;
  return left < right ? -1 : left > right ? 1 : 0;
}
var REASONS = {
  unsupported: "this file uses a OneNote feature the reader does not implement",
  protected: "the file is rights-protected, so its contents are encrypted",
  malformed: "the file is damaged or is not a OneNote section",
  limit: "the file exceeds a safety limit for its size or structure",
  // Overridden per code below; this is the fallback wording.
  unknown: "unexpected failure"
};
var CANCELLED_EXIT = 130;
var ADVICE = {
  ONENOTE_CAB_ENTRY_LIMIT: "Raise it with --max-entry-bytes, e.g. --max-entry-bytes 2G.",
  ONENOTE_CAB_EXPANDED_LIMIT: "Raise it with --max-expanded-bytes, e.g. --max-expanded-bytes 6G. Note that a .onepkg expands whole, so this also needs the memory to hold it.",
  ONENOTE_OBJECT_LIMIT: "Raise it with --max-objects, or convert fewer sections at a time with --sections.",
  ONENOTE_ASSET_LIMIT: "A page embeds a file larger than the reader will materialize. Raise it with --max-asset-bytes, e.g. --max-asset-bytes 512M, or skip embeds with --no-attachments. If a section holds many large files, also raise --max-total-asset-bytes.",
  // The bounded path's own failures. Each of these can only happen under
  // --memory-budget, and each has a different thing to do about it.
  ONENOTE_VALUE_LIMIT: "A page holds a title, link, file name or maths run larger than the memory budget allows to become a string. Raise --memory-budget, which raises the ceiling with it, or convert this file without --memory-budget.",
  ONENOTE_STRUCTURE_LIMIT: "A page holds a structure \u2014 most likely a very wide table \u2014 past what the bounded path will build. Raise --memory-budget, or convert this file without it.",
  ONE2MD_BOUNDED_SCOPE: "The bounded path converts loose .one sections only, because reaching a section inside an archive means expanding the archive. Convert this input without --memory-budget.",
  ONE2MD_TEMP_DIR_LIMIT: "Point --temp-dir somewhere writable with room for the temporary stores, or drop --temp-dir to use the system temporary directory.",
  ENOSPC: "The disk holding the temporary stores is full. A bounded conversion trades memory for temporary disk \u2014 roughly the size of the section, sometimes more \u2014 so point --temp-dir at a filesystem with that much free, or free space where it points now.",
  EDQUOT: "A disk quota stopped the temporary stores growing. Point --temp-dir at a filesystem you are not quota-limited on, such as a local scratch disk.",
  EFBIG: "A temporary store file grew past what the filesystem allows. Point --temp-dir at a filesystem without that limit, or convert this file without --memory-budget.",
  EROFS: "The filesystem --temp-dir points at is read-only. Point it somewhere writable, or drop --temp-dir to use the system temporary directory.",
  PAGED_STORE_SHORT_WRITE: "The temporary store could not be written. Check for free space where --temp-dir points, or point it somewhere with more room.",
  PAGED_STORE_TRUNCATED_FILE: "A temporary store file was truncated while in use. Point --temp-dir at a directory nothing else writes to or cleans up.",
  PAGED_STORE_RECORD_TOO_LARGE: "A single record outgrew a store page, which a very deeply nested notebook can do. Convert this file without --memory-budget.",
  BYTE_SOURCE_SHORT_READ: "The input file ended earlier than its size said. It may have been modified or truncated while the conversion was reading it.",
  BYTE_WINDOW_TOO_LARGE: "A structure in this file is larger than the read window the budget allows. Raise --memory-budget."
};
var LIMIT_ADVICE = "Run with --list to see each section and its expanded size, then convert them in batches with --sections.";
function log(quiet, line) {
  if (!quiet) process.stderr.write(`${line}
`);
}
function reportProgress(quiet, event) {
  const label = event.kind === "section" ? "section" : "page";
  log(quiet, `  ${label} ${event.index}/${event.total}: ${event.name}`);
}
function reportFailures(failures) {
  for (const error of failures) {
    process.stderr.write(`  ! ${error.name}: ${REASONS[error.kind] ?? error.kind} \u2014 ${error.message}
`);
    const advice = ADVICE[error.code ?? ""];
    if (advice) process.stderr.write(`    ${advice}
`);
    else if (error.kind === "limit") process.stderr.write(`    ${LIMIT_ADVICE}
`);
  }
}
async function runBoundedCli(files, options, budget, readerOptions) {
  const closers = new Closers();
  let cancelled = false;
  const stopAfter = Number(process.env.ONE2MD_TEST_CANCEL_AFTER ?? "");
  let checks = 0;
  const isCancelled = Number.isFinite(stopAfter) && stopAfter > 0 ? () => cancelled || ++checks > stopAfter : () => cancelled;
  const onSignal = () => {
    if (cancelled) {
      closers.closeAll();
      process.exit(CANCELLED_EXIT);
    }
    cancelled = true;
    log(options.quiet, "Cancelling; finishing the current note.");
  };
  const onExit = () => closers.closeAll();
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.on("exit", onExit);
  try {
    log(options.quiet, summarize(budget));
    const result = await runBounded({
      files,
      out: options.out,
      budget,
      dryRun: options.dryRun,
      overwrite: options.overwrite,
      readerOptions,
      convert: {
        attachmentsDir: options.attachmentsDir,
        writeAttachments: options.attachments,
        includeDeleted: options.includeDeleted,
        nestSubpages: options.nest,
        frontmatter: options.frontmatter,
        notebookName: options.notebook
      },
      onStart: (file) => log(options.quiet, `Reading ${file}`),
      onProgress: (event) => reportProgress(options.quiet, event),
      onInput: (group) => {
        const notes = group.to.notes - group.from.notes;
        const attachments = group.to.attachments - group.from.attachments;
        const skipped = group.to.skipped - group.from.skipped;
        const errors = group.to.errors - group.from.errors;
        log(options.quiet, `  ${notes} notes, ${attachments} attachments` + (skipped ? `, ${skipped} skipped` : "") + (errors ? `, ${errors} failed` : ""));
      },
      isCancelled
    }, closers);
    if (result.groupCount === 0) {
      throw new UsageError("No .one or .onepkg files found in the given paths");
    }
    for (const group of result.workspace.groups()) {
      if (group.to.errors > group.from.errors) {
        reportFailures(result.workspace.failures(group.from.errors, group.to.errors));
      }
    }
    if (options.json) {
      const out = new BufferedTextOut((text) => process.stdout.write(text));
      writeJsonReport(out, result.workspace, result.workspace.groups(), {
        // A cancelled run is not ok even when nothing failed: it did
        // not finish, and the notes it did not reach are missing
        // rather than absent.
        ok: !result.failed && !result.cancelled,
        out: options.out,
        dryRun: options.dryRun
      });
      out.flush();
    } else if (!options.quiet) {
      process.stdout.write(
        `${options.dryRun ? "Would write" : "Wrote"} ${result.noteCount} notes and ${result.attachmentCount} attachments${options.dryRun ? "" : ` to ${options.out}`}${result.cancelled ? " before being cancelled" : ""}
`
      );
    }
    if (result.cancelled) return CANCELLED_EXIT;
    return result.failed ? 1 : 0;
  } finally {
    closers.closeAll();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    process.off("exit", onExit);
  }
}
async function main(argv) {
  const options = parseArgs(argv);
  const bounded = options.memoryBudget !== void 0 || options.tempDir !== void 0;
  if (bounded) {
    for (const input of options.inputs) {
      if (archiveKind(input)) throw new UsageError(boundedScopeError(input).message);
    }
  }
  const files = bounded ? void 0 : collect(options.inputs);
  if (files && files.length === 0) {
    throw new UsageError("No .one or .onepkg files found in the given paths");
  }
  const limits = {
    ...DEFAULT_CABINET_LIMITS,
    ...options.maxEntryBytes !== void 0 && { maxEntryBytes: options.maxEntryBytes },
    ...options.maxExpandedBytes !== void 0 && { maxExpandedBytes: options.maxExpandedBytes },
    ...options.maxEntries !== void 0 && { maxEntries: options.maxEntries }
  };
  const readerOptions = readerOptionsFrom(options);
  let budget;
  if (bounded) {
    if (options.tempDir !== void 0) {
      try {
        checkTempDirectory(options.tempDir);
      } catch (error) {
        throw new UsageError(
          `${error instanceof Error ? error.message : String(error)}
${ADVICE.ONE2MD_TEMP_DIR_LIMIT}`
        );
      }
    }
    try {
      budget = planBudget(options.memoryBudget ?? DEFAULT_BOUNDED_BUDGET_BYTES, options.tempDir);
    } catch (error) {
      if (error instanceof BudgetError) throw new UsageError(error.message);
      throw error;
    }
  }
  if (options.list) {
    let failed2 = false;
    let listed = 0;
    if (options.json) process.stdout.write("[\n");
    const inputs = files ?? discover(options.inputs);
    for (const file of inputs) {
      const item = (() => {
        try {
          if (bounded) return { file, sections: [listBounded(file)] };
          const data = nodeFs5.readFileSync(file);
          return { file, sections: inspect(data, nodePath4.basename(file), limits) };
        } catch (error) {
          return {
            file,
            sections: [],
            error: error instanceof Error ? error.message : String(error)
          };
        }
      })();
      if (item.error) failed2 = true;
      if (options.json) {
        const text = JSON.stringify(item, null, 2).split("\n").map((line) => `  ${line}`).join("\n");
        process.stdout.write(`${listed > 0 ? ",\n" : ""}${text}`);
      } else {
        process.stdout.write(`${item.file}
`);
        if (item.error) process.stdout.write(`  ! ${item.error}
`);
        for (const section of item.sections) {
          const size = section.expandedLength === void 0 ? "" : `	${(section.expandedLength / 1024 / 1024).toFixed(1)} MiB`;
          const folder = section.folderIndex === void 0 ? "" : `	folder ${section.folderIndex}`;
          process.stdout.write(`  ${[...section.groups, section.title].join(" / ")}	${section.name}${size}${folder}
`);
        }
      }
      listed++;
    }
    if (options.json) process.stdout.write(`${listed > 0 ? "\n" : ""}]
`);
    if (listed === 0) throw new UsageError("No .one or .onepkg files found in the given paths");
    return failed2 ? 1 : 0;
  }
  if (budget) return runBoundedCli(discover(options.inputs), options, budget, readerOptions);
  const reports = [];
  const workspace = new Workspace();
  for (const file of files ?? []) {
    const name = nodePath4.basename(file);
    log(options.quiet, `Reading ${file}`);
    let data;
    try {
      data = nodeFs5.readFileSync(file);
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
      notebookName: options.notebook,
      limits,
      readerOptions,
      workspace,
      onProgress: (event) => reportProgress(options.quiet, event)
    });
    report.input = file;
    reports.push(report);
    log(options.quiet, `  ${report.notes.length} notes, ${report.attachments.length} attachments` + (report.skipped.length ? `, ${report.skipped.length} skipped` : "") + (report.errors.length ? `, ${report.errors.length} failed` : ""));
    reportFailures(report.errors);
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
    const advice = ADVICE[error?.code ?? ""];
    if (error instanceof OneNoteFormatError || advice) {
      process.stderr.write(`${error.message}
`);
      if (advice) process.stderr.write(`  ${advice}
`);
      process.exit(1);
    }
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}
`);
    process.exit(1);
  }
);
