# Third-party code and data

## The OneNote parser — obsidian-importer, MIT

Everything under `src/onenote-file/` is copied from
[obsidianmd/obsidian-importer](https://github.com/obsidianmd/obsidian-importer)
(MIT, Copyright (c) 2023 Obsidian), at the commit recorded in
`src/onenote-file/UPSTREAM_COMMIT`. Their `LICENSE` is reproduced in
`LICENSE-obsidian-importer.txt`.

That directory is a *verbatim* copy, deliberately. It is the part that reads the
MS-ONESTORE binary format, the MS-CAB container and its LZX compression, and it
is not code worth diverging from by hand — a re-sync should be a file copy, not
a merge. `npm run verify:upstream` checks that it still is one, and
`npm run verify:upstream -- --sync` takes upstream's files again.

Three files are the exception, and they are the whole of the adaptation:

| File | Change |
|---|---|
| `src/onenote-file/convert.ts` | Two import paths repointed to the copies below. Nothing else. |
| `src/onenote-file/ink-svg.ts` | Copied from upstream `src/formats/onenote/ink-svg.ts`, which sits outside the parser directory. Unmodified. |
| `src/onenote-file/util.ts` | `extensionFromName` and `extensionFromBytes`, copied out of upstream `src/util.ts`. That module imports `obsidian` on its first line, so it cannot be vendored whole. |

`src/names.ts` also adapts upstream's `sanitizeFileName` and `availableFileName`
from the same `src/util.ts`. The one change is that `Platform.isWin` becomes
`process.platform`. Keeping the rules otherwise identical is what allows this
project's output to be compared against the upstream importer's, which is how
the conversion tests are anchored.

`tests/cabinet.test.ts` is upstream's `tests/onenote-file/cabinet.test.ts`, with
import paths and `__dirname` adjusted for ESM.

## Test inputs

`tests/fixtures/` holds binary OneNote sections and Cabinet archives copied from
projects that publish them as test data, under licences that allow
redistribution. `tests/fixtures/SOURCE.md` records where each came from, at
which commit, and its SHA-256; `tests/fixtures.test.ts` checks those hashes on
every run.

- The `.one` sections: Apache Tika, Apache-2.0 — `LICENSE-APACHE-2.0.txt`, `NOTICE.txt`
- `handwriting_recognition.one`: onenote.rs, MPL-2.0 — `LICENSE-MPL-2.0.txt`
- The `makecab-*` archives: OfficeIMO, MIT

No parser code from Tika, onenote.rs or OfficeIMO is used here; these are inputs
only.
