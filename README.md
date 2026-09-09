# one2md

Convert OneNote `.one` sections and `.onepkg` notebooks to Markdown, entirely
offline. No Microsoft account, no Graph API, no network access at any point —
the binary format is decoded locally.

```bash
node dist/one2md.mjs my-notebook.onepkg -o ./out
```

The bundle is committed and has no runtime dependencies, so that command is the
whole contract: no `npm install`, no `node_modules`. That is what makes it
usable from a sandbox or an agent.

## What it produces

```
out/
  Notebook/                       # only when a file holds several sections
    Section group/                # section groups a .onepkg recorded
      Section/
        Page.md
        Page/                     # created only when a page has subpages
          Subpage.md
        attachments/
          Page image.png
```

Notes carry YAML front matter — `title`, `onenote-id`, `section`, `created`,
`updated`, and `conflict`/`deleted` where they apply. `onenote-id` is the
page's stable source identity, so a re-import can recognise a page it has seen
before.

Handled: rich text, lists, tables, tags and checkboxes, internal page links,
math (as LaTeX), images, embedded files, and ink — strokes become an SVG, and
OneNote's own handwriting recognition text is kept alongside it. `.onepkg`
containers are expanded in-process, including their LZX compression, so
`cabextract` and Windows are not needed.

## Usage

```
one2md <input...> [options]
```

Inputs may be files or folders to search.

| Option | |
|---|---|
| `-o, --out <dir>` | Where to write (default `./out`) |
| `--list` | List the sections in each input and exit |
| `--sections <a,b>` | Only convert these sections of a `.onepkg`, by entry name |
| `--dry-run` | Report what would be written without writing it |
| `--overwrite` | Replace existing files instead of failing on them |
| `--no-attachments` | Leave images and embedded files out |
| `--attachments <d>` | Folder name for assets beside a note (default `attachments`) |
| `--no-frontmatter` | Omit the YAML header |
| `--no-nest` | Write subpages beside their parent, not in a folder |
| `--include-deleted` | Include pages still in OneNote's recycle bin |
| `--json` | Emit a machine-readable report on stdout |
| `-q, --quiet` | Only report failures |

Exit status is `0` when everything converted, `1` when any input or section
failed, `2` on bad usage. `--json` reports every note and attachment written,
everything skipped, and every failure with its `kind` and `code`.

## Both encodings

OneNote writes two different formats under the same `.one` extension, and this
reads both:

- **Desktop** — an MS-ONESTORE revision store, what the OneNote application
  writes locally.
- **Web** — an MS-FSSHTTPB package, what an export from OneNote on the web
  gives you. Other importers commonly decline these.

Which one applies is read from the file header, not guessed from the name. They
share everything above the storage layer, so a page converts through identical
code either way.

## Large notebooks and memory

Peak memory is set by the **largest section**, not the notebook, and it is
dominated by the object graph rather than by bytes — budget roughly **12x a
section's expanded size**. `--list` reports those sizes without decompressing
anything, so you can predict the cost before paying it:

```bash
node dist/one2md.mjs --list notebook.onepkg
```

A `.onepkg` adds a much larger cost on top. A Cabinet folder is one continuous
LZX stream, so it is expanded **whole** even when a single section is wanted,
and the archive stays in memory beside it. `--sections` does not avoid this.

**Extract the archive first.** A `.onepkg` is an LZX Cabinet archive, and any
CAB extractor streams it, which turns the archive cost into nothing:

```bash
7zz x notebook.onepkg -o./sections
node dist/one2md.mjs ./sections -o ./out --notebook "My Notebook"
```

`7zz`, `7z` and `cabextract` all work. None is guaranteed to be present — a
sandbox often has none installed, and one installed there may not survive into
the next session — so check for one before depending on it.

`--notebook` restores the name the archive would have supplied, so the output is
byte-identical to converting the `.onepkg` directly. Converting the sections one
at a time bounds peak to a single section.

Measured on a generated 725 MiB notebook (12 sections of 60.3 MiB, one folder):

| approach | peak |
|---|---|
| convert the `.onepkg` directly | 2,791 MiB |
| `7zz x` to extract it | **4 MiB** |
| convert one extracted 60.3 MiB section | **688 MiB** |

Extraction is flat in memory — 4 MiB on a 145 MiB archive and 4 MiB on a 725 MiB
one — so this route scales to notebooks that cannot be expanded in RAM at all.

The caps that stop a runaway archive are adjustable: `--max-entry-bytes`,
`--max-expanded-bytes`, `--max-entries`, and `--max-objects` (which bounds heap
per section, and is worth *lowering* on a small machine). Embedded files have
their own ceilings: `--max-asset-bytes` (one file, default 64M) and
`--max-total-asset-bytes` (the sum in a section, default 256M). Raising the
per-file flag also raises the total to at least that size. Defaults are
conservative on purpose — they are what stops a malformed file expanding without
bound.

### A fixed memory ceiling: `--memory-budget`

Everything above scales with the input. `--memory-budget` does not: it converts
a loose `.one` section through a path that indexes the file on disk and streams
a page at a time, so the memory the converter uses is the number you gave it
whatever the section's size.

```bash
7zz x notebook.onepkg -o./sections
node dist/one2md.mjs ./sections -o ./out --notebook "My Notebook" \
  --memory-budget 8M --temp-dir /var/tmp
```

Output is byte-identical to converting without the flag. This is a different
storage layer under the same conversion, not a different converter, and the
test suite checks the two agree on every fixture in both encodings.

**Scope: loose `.one` sections only.** A `.onepkg` or `.onex` named directly is
refused rather than silently converted the unbounded way, because reaching a
section inside one means expanding the Cabinet folder whole — the single
largest allocation in this program, and the thing a budget is being asked to
avoid. Extract first, as above, and point the converter at the folder. The same
refusal applies to an archive found by scanning a folder: that input fails and
the rest of the batch continues.

**What the number covers.** Every buffer the converter allocates and every
string it chooses to build: the three page caches, the read window, the write
and spill buffers, a reserve for the record copies a store hands to its
callers, and a reserve for the handful of values that have no streaming form —
a page title, because it becomes a file name; a hyperlink target; a maths run,
because NFKC normalization needs the whole string. The ceilings on those values
are derived from the reserve, so a title too large to fit is a reported failure
on that page rather than an allocation the budget did not plan for.

The floor is 1 MiB. Below that the reserves and the three caches cannot all
have their minimum and there is nothing left for the read window, so it is
refused with a message saying so rather than quietly under-provisioned.

**What it does not cover**, and cannot:

- Node and V8 themselves. An idle Node is tens of megabytes of resident set
  before a byte of OneNote is read, and no option here changes that.
- Garbage V8 has not yet collected. The reserve covers the copies that are
  live at once, not how promptly the collector reclaims the dead ones.
- The kernel's page cache over the temporary files, which is reclaimable
  memory the operating system manages rather than an allocation.

So `--memory-budget 8M` means the converter's own memory is eight mebibytes. It
does not mean the process is eight mebibytes, and it never could.

**Temporary disk.** The index, the resolver cache and the output bookkeeping
live in files instead of in the heap — that is the trade. Expect temporary
space on the order of the section's size. `--temp-dir` chooses where; each
store creates and removes its own subdirectory and never touches the root you
gave it. A full disk or a quota there is reported as such, with the directory
named.

**Cost.** Slower than the default path — every lookup that was a `Map` is now a
page read — and it needs the disk. Use it when a section will not fit in
memory, or when memory is capped and the failure has to be an error rather than
an out-of-memory kill. `--memory-budget` and `--temp-dir` are the only way in;
without them nothing changes.

**Cancelling.** Ctrl-C stops the run: the note being written is abandoned and
its file removed, the notes already finished stay where they are, the temporary
stores are cleaned up, and the exit code is 130. A cancelled run reports
`"ok": false` and marks the input `"cancelled": true`, because a conversion
that stopped early is not a conversion that succeeded, and a script that cannot
tell those apart will publish a notebook with pages missing. A second Ctrl-C
exits immediately, and still deletes the note and asset it was in the middle of
writing before it goes.

Interruption is checked between pages, so a Ctrl-C lands within one page rather
than instantly — on a page holding a very large attachment, that is however long
the attachment takes to copy.

**Measured.** `scripts/bench-bounded.mjs` generates loose sections in both
encodings at increasing sizes, converts each in a child process under one
budget, and checks three things: that the output matches the default path byte
for byte, that the converter's own accounted high-water mark does not move as
the input grows, and that the conversion completes under a hard
`--max-old-space-size`. On a run over sections of 3.1 MiB and 12.4 MiB — four
times the input — the accounted high water was identical at both sizes, in both
encodings, and every conversion fitted inside a 96 MiB heap.

Resident set size is reported alongside and is deliberately not claimed to be
flat. It was 193 MiB and 241 MiB for those two desktop sections, which is Node,
the JIT and uncollected garbage rather than the converter: the same runs fitted
inside a 96 MiB heap when V8 was told to enforce one, which is what shows the
growth is slack rather than retention. RSS is in the table because a real
regression would show up in it, not because the number itself means much.

The generated sizes need .NET and OfficeIMO, and the benchmark skips itself
when they are absent. The committed fixtures are all under 200 KiB and prove
nothing about scale — but the heap-cap checks that do not need generation are
in the test suite and always run, including one that decodes a three-million
point ink path inside a 40 MiB heap and requires the array-based decoder it
replaced to run out of memory on the same input.

### What did not work

Copying expanded sections to temporary files so the archive buffer could be
released was implemented and measured: **it did not lower peak memory** — 1,141
MiB against 1,144 MiB in memory. The folder is allocated whole before any section
is decoded, so the high-water mark is already set by the time there is anything
to release. Forcing a collection first made no difference. It was removed rather
than shipped as a knob that does nothing.

## What it will not convert

A rights-protected `.onex` is declined: its contents are encrypted, and nothing
here can open them. A damaged file is reported as malformed.

Failures are per section, so one unreadable section in a notebook does not cost
you the rest.

## Using it from Claude

`skills/onenote-to-markdown/` is a Claude skill wrapping the same CLI. Copy the
directory into `.claude/skills/` (or a Cowork project's skills folder) and it
works on its own — the bundle is copied in beside `SKILL.md`, so nothing else
from this repository has to come with it.

```bash
cp -r skills/onenote-to-markdown ~/.claude/skills/
```

The skill tells the model to shell out to the converter and read its `--json`
report, and — the part that matters — not to try to read the binary itself. Its
failure codes are documented there, so an unreadable file produces an
explanation rather than an attempt to salvage bytes.

## Where the parser comes from

`src/onenote-file/` is a verbatim copy of the OneNote reader from
[obsidian-importer](https://github.com/obsidianmd/obsidian-importer) (MIT),
pinned to the commit in `src/onenote-file/UPSTREAM_COMMIT`. It carries no
dependency on Obsidian, works in `Uint8Array` throughout, and takes a
`saveAttachment` callback rather than writing files itself — so the adaptation
is a matter of supplying the layer the plugin supplies for itself, not of
porting a parser.

That layer is this repository: file discovery, the folder hierarchy, name
sanitising and collision handling, front matter, and the CLI.

Keeping the copy verbatim is deliberate — a re-sync should be a file copy, not a
merge. See `NOTICE.md` for exactly what was changed and why.

## Development

```bash
npm install
npm test              # 85 tests, no network
npm run typecheck
npm run build         # rebuild dist/one2md.mjs
npm start -- --help   # run from source via tsx
```

Three things are being checked:

**The Cabinet and LZX port, against Microsoft.** `tests/cabinet.test.ts` expands
archives produced by the Windows `makecab` utility and asserts the source bytes
come back. Agreement is with Microsoft's compressor, not with a recording of our
own output.

**The packaged reader, against itself.** A packaged section's structures are
read with exact-length assertions and cross-checked: the storage index must
account for every manifest in the file, and each object declaration must agree
with the data beside it on size and reference counts. The format leaves no
padding, so these cannot pass by accident.

**The whole pipeline, against recorded trees.** `tests/convert.test.ts` runs
every fixture through the real conversion and compares file by file with
`tests/expected/`. Recording is opt-in and always fails the run:

```bash
UPDATE_EXPECTED=1 npm test   # writes the recording, then fails
npm test                     # passes once you have read the diff
```

**The fixtures themselves.** `tests/fixtures.test.ts` checks each input's
SHA-256 against the hashes published upstream, because an expectation is only an
anchor if it is pinned to the same bytes.

To convert a file you cannot commit — your own export — drop it in
`tests/local/`. It is gitignored, its recording is written to
`tests/local/expected/`, and nothing about it leaves the machine.

**Against a second implementation.** `npm run verify:officeimo` reads every
fixture with [OfficeIMO](https://github.com/EvotecIT/OfficeIMO) (C#, MIT) and
compares section names, page order, page titles, the words each page carries,
and attachment bytes by SHA-256. This is what anchors the **web-export** path:
unlike the desktop trees, its recordings have no upstream to check against.

It is development-only — it needs the .NET SDK, skips cleanly without it, and
nothing it touches is shipped. Markdown styling and timestamps are excluded by
design, and per-file divergences are listed with reasons in the script rather
than silently tolerated.

### Re-syncing the parser

```bash
npm run verify:upstream            # report drift from the pinned commit
npm run verify:upstream -- --sync  # take upstream's files again
npm test
```

`verify:upstream` also re-runs the conversion and compares it to upstream's own
recorded output, front matter aside. Today every markdown body and every
attachment matches byte for byte. To move to a newer upstream, edit
`src/onenote-file/UPSTREAM_COMMIT` and run it with `--sync`.

## Licence

MIT. Portions are copied from obsidian-importer and remain under its own MIT
licence; test inputs are redistributed under Apache-2.0, MPL-2.0 and MIT. See
`NOTICE.md`.
