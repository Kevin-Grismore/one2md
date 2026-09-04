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
			Console.Error.WriteLine("write <output-directory> [--large [sections] [pagesPerSection] [paragraphsPerPage]]");
			return 2;
		}

		var directory = args[0];
		Directory.CreateDirectory(directory);

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
