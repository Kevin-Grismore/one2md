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
`2` on bad usage. Page progress goes to stderr as `page 12/340: Title`, so
`--json` stdout stays clean; `--quiet` suppresses it.

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

**For a large notebook, extract it first.** A `.onepkg` is an LZX Cabinet
archive, and any CAB extractor streams it, so extraction is nearly free and
removes the archive cost entirely:

```bash
7zz x notebook.onepkg -o./sections          # or 7z, or cabextract
node one2md.mjs ./sections -o ./out --notebook "My Notebook"
```

`--notebook` restores the name the archive would have supplied, making the output
identical to converting the `.onepkg` directly. If even that is too much memory,
convert the extracted sections one file at a time into the same `-o` directory.

### If no extractor is installed

Sandboxes often have none — check before relying on one:

```bash
7zz --help || 7z --help || cabextract --version
```

If none is present, install one. Any CAB-capable extractor will do, so work out
the right package for the environment rather than assuming a particular command;
`p7zip-full` and `cabextract` are the usual names. It may not need elevation, and
it may not persist, so expect to install again in a later session.

Only do this when a notebook is actually large enough to need it. For anything
that converts directly, extracting first is wasted work — and installing a tool
the person did not ask for is worth a word first if the notebook turns out to be
small enough after `--list`.

Measured on a 725 MiB notebook: converting the `.onepkg` directly peaked at
2,791 MiB; extracting it peaked at 4 MiB and converting one 60 MiB section at
688 MiB.

## When memory is capped: `--memory-budget`

Everything above still scales with the section. `--memory-budget` does not — it
converts through a path that indexes the file on disk and streams a page at a
time, so the converter uses the number given whatever the section's size.

```bash
7zz x notebook.onepkg -o./sections
node one2md.mjs ./sections -o ./out --notebook "My Notebook" \
  --memory-budget 8M --temp-dir /var/tmp
```

The output is byte-identical to converting without the flag, so there is no
reason to check the result differently.

The bounded path first makes a metadata-only page pass to obtain the exact
progress total. It does not render page bodies or assets and keeps traversal
state on disk, though page metadata is looked up again during conversion.

**It takes loose `.one` sections only.** Naming a `.onepkg` or `.onex` with
`--memory-budget` set is an error, not a fallback: reaching a section inside one
means expanding the Cabinet folder whole, which is the largest allocation this
program makes and the thing a budget exists to avoid. Extract first — the
workflow above is the workflow — and point it at the folder. An archive found
by scanning a folder fails as that one input while the rest of the batch
converts.

**Use it when** a section will not fit in memory, or when the environment has a
hard memory cap and an out-of-memory kill would be worse than an error. Do not
reach for it by default: it is slower, because every lookup that was in memory
is now a read, and it needs temporary disk on the order of the section's size.
`--temp-dir` says where; each store makes and removes its own subdirectory and
leaves the root alone.

**What the number means.** Every buffer the converter allocates, plus a reserve
for the record copies its stores hand out and one for the few values that
cannot be streamed — a page title, a link target, a maths run. It does **not**
cover Node and V8, which are tens of megabytes on their own, nor garbage not
yet collected. `--memory-budget 8M` means the converter's memory is 8 MiB; the
process will be larger, and no option changes that. The floor is 1 MiB; below
it the budget is refused rather than under-provisioned.

Measured: sections of 3.1 MiB and 12.4 MiB gave the same accounted high-water
mark in both encodings, and every conversion fitted inside a 96 MiB V8 heap cap.
Resident set size is *not* flat — it was 193 MiB and 241 MiB for those two — and
that is Node and uncollected garbage rather than the converter, which is what
the enforced heap cap distinguishes.

**Cancelling.** Ctrl-C abandons the note in progress and deletes it, keeps the
notes already finished, cleans up the temporary stores and exits **130**. It
takes effect between pages, so allow up to one page — longer if that page holds
a large attachment. A second Ctrl-C exits at once and still removes the note and
asset being written. The report says `"ok": false` and marks the input
`"cancelled": true`. Never treat a cancelled run as a complete one.

New failures to expect, all reported per page or per input:

- **`ONENOTE_VALUE_LIMIT`** — a title, link or maths run larger than the budget
  reserved for one. Raise `--memory-budget`, which raises the ceiling with it.
- **`ONENOTE_STRUCTURE_LIMIT`** — a table with more columns than the limit.
- **`ONE2MD_BOUNDED_SCOPE`** — a `.onepkg` or `.onex` in bounded mode. Extract
  it first.
- **`ENOSPC` / `EDQUOT`** — the temporary disk filled up or hit a quota. Point
  `--temp-dir` somewhere with room.
- **`ONENOTE_INK_PATH_LIMIT`** — a stroke claiming more coordinates than
  `--max-ink-path-values` allows. Ink is decoded a coordinate at a time, so this
  is a malformed-file guard rather than a memory one.

## Options worth knowing

| Need | Flag |
|---|---|
| Only the text | `--no-attachments` |
| Plain Markdown, no YAML header | `--no-frontmatter` |
| Subpages beside their parent, not nested in a folder | `--no-nest` |
| Pages still in OneNote's recycle bin | `--include-deleted` |
| Re-run into a folder that already has output | `--overwrite` |
| Raise a size ceiling a big archive trips | `--max-entry-bytes`, `--max-expanded-bytes` |
| Raise the embedded-file ceiling a large attachment trips | `--max-asset-bytes`, `--max-total-asset-bytes` |
| Bound memory per section on a small machine | `--max-objects` (lower it) |
| Convert a loose `.one` under a fixed memory ceiling | `--memory-budget`, `--temp-dir` |

By default each note gets YAML front matter with `title`, `onenote-id`,
`section`, `created` and `updated`. Images, ink (as SVG) and embedded files land
in an `attachments/` folder beside the note.

## When a file will not convert

Read `errors[].code` in the JSON and report it plainly. Do not fall back to
reading the bytes yourself. Raise a named ceiling only when the error names
one; otherwise these are real limits, not glitches.

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
- **`ONENOTE_ASSET_LIMIT`** — a page embeds a file larger than the reader will
  materialize (default 64 MiB each, 256 MiB in total per section). Raise
  `--max-asset-bytes` and retry; if the section still fails, also raise
  `--max-total-asset-bytes`. Or convert without embeds using `--no-attachments`.
- **Anything else** — the file is damaged, or is not a OneNote section.

A failure is reported per section, so a notebook with one bad section still
converts the rest. Check `notes` before concluding a run produced nothing.

Anything the converter could not represent in Markdown is listed in `skipped`
with a reason rather than dropped silently — mention it if the person is
checking for completeness.

## Requirements

Node 20 or newer. `one2md.mjs` is a single self-contained file — no
`npm install`, no `node_modules`, no network.
