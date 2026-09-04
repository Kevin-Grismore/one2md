---
name: onenote-to-markdown
description: Convert OneNote files to Markdown. Use whenever a `.one`, `.onepkg`, or `.onex` file is involved — converting a OneNote notebook or section to Markdown, extracting the text or images out of one, migrating OneNote notes into Obsidian or another vault, or reading what a `.one` file contains. Also use when someone refers to a OneNote export or backup by filename. Reads both desktop and web-exported OneNote files. Works entirely offline; no Microsoft account or Graph API.
---

# OneNote to Markdown

`.one` and `.onepkg` are proprietary binary formats. **Do not try to read them
yourself** — not with `cat`, `strings`, `grep`, `unzip`, a Python script, or by
inspecting bytes. Run the bundled converter, which implements MS-ONESTORE, the
MS-FSSHTTPB packaging OneNote's web export uses, and the MS-CAB/LZX container.

## Convert

```bash
node one2md.mjs <input...> -o <output-dir> --json
```

Use the `one2md.mjs` sitting beside this file. Inputs may be `.one` files,
`.onepkg` notebooks, or folders to search. Nothing goes over the network.

Always pass `--json` — the report on stdout tells you exactly what happened:

```json
{
  "ok": true,
  "out": "out",
  "reports": [{
    "input": "notebook.onepkg",
    "notes": ["Notebook/Section/Page.md"],
    "attachments": ["Notebook/Section/attachments/Page image.png"],
    "skipped": [],
    "errors": []
  }]
}
```

Exit status is `0` when everything converted, `1` when any section failed,
`2` on bad usage. Progress goes to stderr, so `--json` stdout stays clean.

## Look before converting

```bash
node one2md.mjs --list notebook.onepkg
```

Lists the sections without decoding any of them. Worth doing first for a large
notebook, or when the person only wants part of it — then pass
`--sections "Section A.one,Section B.one"` using the entry names it printed.

`--dry-run` reports what would be written without writing anything.

## Large notebooks

Peak memory is set by the **largest section**, not the notebook — budget roughly
**12x a section's expanded size**. `--list` reports those sizes without
decompressing anything, so check first:

```bash
node one2md.mjs --list notebook.onepkg
```

A `.onepkg` costs far more again: its Cabinet folder expands **whole** even for
one section, and the archive stays in memory beside it. `--sections` does not
avoid that.

**For any large notebook, extract it first.** Extraction streams, so it costs
almost nothing, and it removes the archive cost entirely:

```bash
7zz x notebook.onepkg -o./sections          # or 7z, or cabextract
node one2md.mjs ./sections -o ./out --notebook "My Notebook"
```

`--notebook` restores the name the archive would have supplied, making the output
identical to converting the `.onepkg` directly. If even that is too much memory,
convert the extracted sections one file at a time into the same `-o` directory.

Measured on a 725 MiB notebook: converting the `.onepkg` directly peaked at
2,791 MiB; extracting it peaked at 4 MiB and converting one 60 MiB section at
688 MiB.

## Options worth knowing

| Need | Flag |
|---|---|
| Only the text | `--no-attachments` |
| Plain Markdown, no YAML header | `--no-frontmatter` |
| Subpages beside their parent, not nested in a folder | `--no-nest` |
| Pages still in OneNote's recycle bin | `--include-deleted` |
| Re-run into a folder that already has output | `--overwrite` |
| Raise a size ceiling a big archive trips | `--max-entry-bytes`, `--max-expanded-bytes` |
| Bound memory per section on a small machine | `--max-objects` (lower it) |

By default each note gets YAML front matter with `title`, `onenote-id`,
`section`, `created` and `updated`. Images, ink (as SVG) and embedded files land
in an `attachments/` folder beside the note.

## When a file will not convert

Read `errors[].code` in the JSON and report it plainly. Do not retry, and do not
fall back to reading the bytes yourself — these are real limits, not glitches.

- **`ONENOTE_ONEX_PROTECTED`** — the file is rights-protected and its contents
  are encrypted. Nothing can be recovered from it here.
- **`ONENOTE_ONEX_UNSUPPORTED`** — a compound `.onex` this reader does not
  recognise.
- **`ONENOTE_CAB_ENTRY_LIMIT` / `ONENOTE_CAB_EXPANDED_LIMIT`** — the archive is
  larger than the default ceilings. The converter prints which flag lifts each
  one; also consider extracting the `.onepkg` first, as above.
- **`ONENOTE_OBJECT_LIMIT`** — a section holds more objects than the reader will
  build. Convert fewer sections at a time, or raise `--max-objects` if there is
  memory for it.
- **Anything else** — the file is damaged, or is not a OneNote section.

A failure is reported per section, so a notebook with one bad section still
converts the rest. Check `notes` before concluding a run produced nothing.

Anything the converter could not represent in Markdown is listed in `skipped`
with a reason rather than dropped silently — mention it if the person is
checking for completeness.

## Requirements

Node 20 or newer. `one2md.mjs` is a single self-contained file — no
`npm install`, no `node_modules`, no network.
