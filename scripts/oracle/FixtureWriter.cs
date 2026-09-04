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
		if (args.Length != 1) {
			Console.Error.WriteLine("write <output-directory>");
			return 2;
		}

		var directory = args[0];
		Directory.CreateDirectory(directory);

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
}
