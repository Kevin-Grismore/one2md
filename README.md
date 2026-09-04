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
