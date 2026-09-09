// Generates a test fixture this repository cannot otherwise obtain.
//
// The packaged (web export) reader has a path that carries images and embedded
// files through an object group's file-data partition. Neither published web
// export fixture embeds anything, so that path was written but never executed.
// OfficeIMO can *write* the packaged encoding, so the missing case can be
// produced rather than waited for.
//
// The output is committed as a fixture. It is this project's own bytes — the
// generator is MIT-licensed and the content is authored here — so it carries no
// third-party redistribution terms, unlike the corpus fixtures beside it.
using OfficeIMO.OneNote;

static class FixtureWriter {
	/// A 1×1 PNG. Small, valid, and byte-identical on every run.
	static readonly byte[] Png = Convert.FromBase64String(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==");

	static readonly byte[] TextFile =
		"one2md attachment fixture: this file rides through the packaged file-data path.\n"u8.ToArray();

	public static int Run(string[] args) {
		if (args.Length == 0) {
			Console.Error.WriteLine("""
			write <output-directory> [mode]

			  (no mode)   The committed packagedWithAttachments.one fixture
			  --large     One large .onepkg notebook
			  --sections  Loose .one sections at increasing sizes, in both encodings
			              [pagesPerSection...] [--paragraphs n] [--runs n]
			""");
			return 2;
		}

		var directory = args[0];
		Directory.CreateDirectory(directory);

		if (args.Contains("--sections")) return WriteSections(directory, args);
		if (args.Contains("--large")) return WriteLarge(directory, args);

		var section = new OneNoteSection { Name = "Attachments" };
		section.Pages.Add(BuildPage());

		var path = Path.Combine(directory, "packagedWithAttachments.one");
		OneNoteSectionWriter.Write(section, path, new OneNoteWriterOptions {
			// The point of the fixture: the sync-path encoding, not the desktop one.
			StorageFormat = OneNoteStorageFormat.FileSynchronizationPackage,
			ValidateRoundTrip = true,
		});

		Console.WriteLine(path);
		return 0;
	}

	static OneNotePage BuildPage() {
		var page = new OneNotePage { Title = "Page With Attachments", Level = 0 };
		var outline = new OneNoteOutline();

		outline.Children.Add(Text("This page carries an image and an embedded file."));

		outline.Children.Add(new OneNoteImage {
			FileName = "pixel.png",
			MediaType = "image/png",
			AltText = "A single pixel",
			Payload = OneNoteBinaryPayload.FromBytes(Png),
		});

		outline.Children.Add(new OneNoteEmbeddedFile {
			FileName = "notes.txt",
			MediaType = "text/plain",
			Payload = OneNoteBinaryPayload.FromBytes(TextFile),
		});

		page.Outlines.Add(outline);
		return page;
	}

	static OneNoteParagraph Text(string value) {
		var paragraph = new OneNoteParagraph();
		paragraph.Runs.Add(new OneNoteTextRun { Text = value });
		return paragraph;
	}

	/// <summary>
	/// Loose sections at increasing sizes, in both encodings.
	///
	/// The bounded conversion path takes loose <c>.one</c> sections and nothing
	/// else, so the <c>--large</c> notebook below cannot exercise it: reaching a
	/// section inside a Cabinet archive means expanding the archive, which is
	/// the thing the bounded path refuses to do. This writes what it can
	/// actually convert.
	///
	/// Sizes rather than a size, because the claim being tested is about a
	/// *derivative*: memory should not grow with the input. One measurement can
	/// only show a number, and a number proves nothing on its own — a series
	/// shows whether the line is flat. Both encodings, because they are
	/// separate readers with separate indexers and only one of them being
	/// bounded would be easy to miss.
	///
	/// Not committed: it is megabytes of synthetic filler, reproducible from
	/// here whenever a measurement is wanted.
	/// </summary>
	static int WriteSections(string directory, string[] args) {
		var pageCounts = Numbers(args, "--sections");
		if (pageCounts.Length == 0) pageCounts = [50, 200, 800];

		var paragraphs = Option(args, "--paragraphs") ?? 40;
		var runs = Option(args, "--runs") ?? 6;

		foreach (var format in new[] {
			OneNoteStorageFormat.RevisionStore,
			OneNoteStorageFormat.FileSynchronizationPackage,
		}) {
			// The names say which reader each one exercises, since that is the
			// only thing distinguishing two files of identical content.
			var encoding = format == OneNoteStorageFormat.RevisionStore ? "desktop" : "web";

			foreach (var pages in pageCounts) {
				var section = new OneNoteSection { Name = $"Bench {encoding} {pages:D5}" };

				for (var index = 0; index < pages; index++) {
					section.Pages.Add(BenchPage(index, paragraphs, runs));
				}

				var path = Path.Combine(directory, $"bench-{encoding}-{pages:D5}.one");
				OneNoteSectionWriter.Write(section, path, new OneNoteWriterOptions {
					StorageFormat = format,
					MaxOutputBytes = 8L * 1024 * 1024 * 1024,
				});

				Console.WriteLine($"{path}\t{new FileInfo(path).Length}\t{encoding}\t{pages}");
			}
		}

		return 0;
	}

	/// <summary>
	/// A page with enough shape to reach the interesting code.
	///
	/// Plain paragraphs would exercise one path repeatedly. This mixes headings,
	/// several runs per paragraph so that the run-merging and style logic is
	/// used, and a table every few pages, because a table is where the streaming
	/// cell renderer lives.
	/// </summary>
	static OneNotePage BenchPage(int index, int paragraphs, int runs) {
		var page = new OneNotePage { Title = $"Bench Page {index + 1:D5}", Level = index % 7 == 6 ? 1 : 0 };
		var outline = new OneNoteOutline();

		for (var line = 0; line < paragraphs; line++) {
			var paragraph = new OneNoteParagraph();

			for (var run = 0; run < runs; run++) {
				var textRun = new OneNoteTextRun {
					Text = $"Page {index + 1} line {line + 1} run {run + 1}. "
						+ "Filler that compresses like prose rather than like zeroes, so the "
						+ "section's size bears some relation to a real one's. ",
				};

				// Mixed formatting on purpose: a section of undifferentiated
				// plain text would exercise one path over and over, and the
				// run-merging is where the streaming writer is most intricate.
				textRun.Style.Bold = run % 3 == 1;
				textRun.Style.Italic = run % 5 == 2;

				paragraph.Runs.Add(textRun);
			}

			outline.Children.Add(paragraph);
		}

		// Every fifth page gets a table, because a table is where the streaming
		// cell renderer lives and a benchmark that never builds one would leave
		// the most intricate part of the bounded path unmeasured.
		if (index % 5 == 4) outline.Children.Add(BenchTable(index));

		page.Outlines.Add(outline);
		return page;
	}

	static OneNoteTable BenchTable(int index) {
		var table = new OneNoteTable();

		for (var row = 0; row < 8; row++) {
			var line = new OneNoteTableRow();

			for (var column = 0; column < 5; column++) {
				var cell = new OneNoteTableCell();
				cell.Content.Add(Text($"p{index + 1} r{row + 1} c{column + 1} cell text"));
				line.Cells.Add(cell);
			}

			table.Rows.Add(line);
		}

		return table;
	}

	/// The integers following a flag, up to the next flag.
	static int[] Numbers(string[] args, string flag) {
		var at = Array.IndexOf(args, flag);
		if (at < 0) return [];

		var found = new List<int>();
		for (var index = at + 1; index < args.Length; index++) {
			if (args[index].StartsWith("--")) break;
			if (int.TryParse(args[index], out var value) && value > 0) found.Add(value);
		}

		return [.. found];
	}

	/// The single integer following a flag.
	static int? Option(string[] args, string flag) {
		var at = Array.IndexOf(args, flag);
		if (at < 0 || at + 1 >= args.Length) return null;
		return int.TryParse(args[at + 1], out var value) && value > 0 ? value : null;
	}

	/// <summary>
	/// A notebook big enough to measure against.
	///
	/// The committed fixtures top out at 176 KiB, four orders of magnitude below a
	/// real notebook, and peak memory at that size is still dominated by one-time
	/// JIT. Nothing about memory can be claimed from them, so this generates
	/// something with a realistic shape: many sections, many pages, real text.
	///
	/// Deliberately not committed — it is megabytes of synthetic filler, and it is
	/// reproducible from this code whenever a measurement is needed.
	/// </summary>
	static int WriteLarge(string directory, string[] args) {
		var numbers = args.Skip(1).Where(a => int.TryParse(a, out _)).Select(int.Parse).ToArray();
		var sections = numbers.ElementAtOrDefault(0) is > 0 and var s ? s : 12;
		var pages = numbers.ElementAtOrDefault(1) is > 0 and var p ? p : 60;
		var paragraphs = numbers.ElementAtOrDefault(2) is > 0 and var t ? t : 40;

		var notebook = new OneNoteNotebook { Name = "Large" };

		for (var index = 0; index < sections; index++) {
			var section = new OneNoteSection { Name = $"Section {index + 1:D3}" };

			for (var pageIndex = 0; pageIndex < pages; pageIndex++) {
				var page = new OneNotePage { Title = $"Section {index + 1:D3} Page {pageIndex + 1:D4}", Level = 0 };
				var outline = new OneNoteOutline();

				for (var line = 0; line < paragraphs; line++) {
					outline.Children.Add(Text(
						$"Section {index + 1} page {pageIndex + 1} paragraph {line + 1}. "
						+ "Filler that compresses like prose rather than like zeroes, so the "
						+ "archive's expanded size bears some relation to a real notebook's."));
				}

				page.Outlines.Add(outline);
				section.Pages.Add(page);
			}

			notebook.Sections.Add(section);
		}

		var path = Path.Combine(directory, "large.onepkg");
		// StorageFormat describes how each *section* is serialized; the package
		// writer decides the Cabinet wrapper on its own.
		OneNotePackageWriter.Write(notebook, path, new OneNoteWriterOptions {
			StorageFormat = OneNoteStorageFormat.RevisionStore,
			MaxOutputBytes = 8L * 1024 * 1024 * 1024,
		});

		var size = new FileInfo(path).Length;
		Console.WriteLine($"{path}\t{size:N0} bytes\t{sections} sections x {pages} pages x {paragraphs} paragraphs");
		return 0;
	}
}
