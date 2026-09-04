// A development-only oracle over OfficeIMO (MIT).
//
// Nothing here ships. `dist/one2md.mjs` remains a single dependency-free Node
// file; this exists so the packaged (web export) conversion path can be checked
// against an independent implementation of the same file formats, which is the
// one thing our own recordings cannot do for us.
//
// It prints a structural description of each input as JSON. Markdown *styling*
// is expected to differ between the two projects — this deliberately reports
// the things that must agree regardless of styling: which sections and pages
// exist, in what order, at what nesting, with which attachments and bytes.
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

using OfficeIMO.OneNote;
using OfficeIMO.OneNote.Markdown;

const string UsageText = """
one2md-oracle — structural description of OneNote files, via OfficeIMO

  dump <file...>   Print JSON describing each file's sections, pages and attachments
  write <dir>      Write generated fixtures into <dir>
""";

if (args.Length == 0) { Console.Error.Write(UsageText); return 2; }

return args[0] switch {
	"dump" => Oracle.Dump(args.Skip(1).ToArray()),
	"write" => FixtureWriter.Run(args.Skip(1).ToArray()),
	_ => Oracle.Fail(),
};

static class Oracle {
	internal const string UsageText = """
one2md-oracle — structural description of OneNote files, via OfficeIMO

  dump <file...>   Print JSON describing each file's sections, pages and attachments
  write <dir>      Write generated fixtures into <dir>
""";

	internal static int Fail() { Console.Error.Write(UsageText); return 2; }

	internal static int Dump(string[] paths) {
		if (paths.Length == 0) return Fail();

		var results = new List<FileReport>();

		foreach (var path in paths) {
			try {
				results.Add(Describe(path));
			}
			catch (Exception error) {
				results.Add(new FileReport {
					Input = Path.GetFileName(path),
					Ok = false,
					Error = $"{error.GetType().Name}: {error.Message}",
					Code = (error as OneNoteFormatException)?.Code,
				});
			}
		}

		Console.WriteLine(JsonSerializer.Serialize(results, JsonContext.Default.ListFileReport));
		return results.Any(r => !r.Ok) ? 1 : 0;
	}

	static FileReport Describe(string path) {
		var name = Path.GetFileName(path);
		var sections = new List<SectionReport>();

		// A .onepkg is a notebook; a bare .one is one section. OfficeIMO splits
		// these across two readers, as we split them across cabinet and non-cabinet.
		if (name.EndsWith(".onepkg", StringComparison.OrdinalIgnoreCase)) {
			var notebook = OneNotePackageReader.Read(path, new OneNoteNotebookReaderOptions());
			foreach (var section in Walk(notebook)) sections.Add(Describe(section));
		}
		else {
			sections.Add(Describe(OneNoteSectionReader.Read(path, new OneNoteReaderOptions())));
		}

		return new FileReport { Input = name, Ok = true, Sections = sections };
	}

	/// Sections of a notebook, including those inside section groups, depth first.
	static IEnumerable<OneNoteSection> Walk(OneNoteNotebook notebook) {
		foreach (var section in notebook.Sections) yield return section;
		foreach (var group in notebook.SectionGroups)
			foreach (var section in Walk(group)) yield return section;
	}

	static IEnumerable<OneNoteSection> Walk(OneNoteSectionGroup group) {
		foreach (var section in group.Sections) yield return section;
		foreach (var child in group.SectionGroups)
			foreach (var section in Walk(child)) yield return section;
	}

	static SectionReport Describe(OneNoteSection section) {
		var pages = new List<PageReport>();

		foreach (var page in section.Pages) {
			var attachments = new List<AttachmentReport>();

			// The projection hands every binary element to this callback and uses
			// what it returns as the link target, which is how attachments are
			// captured without writing any files.
			string Capture(OneNoteBinaryElement element) {
				var bytes = element.Payload?.ToArray(long.MaxValue) ?? [];
				attachments.Add(new AttachmentReport {
					FileName = element.FileName,
					MediaType = element.MediaType,
					Bytes = bytes.Length,
					Sha256 = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant(),
				});
				return element.FileName ?? "attachment";
			}

			string markdown;
			try {
				// Heading levels are 1-based; 0 is rejected.
				markdown = OneNoteMarkdownProjection.ToMarkdown(page, 1, Capture);
			}
			catch (Exception error) {
				markdown = string.Empty;
				attachments.Add(new AttachmentReport { FileName = $"<failed: {error.Message}>" });
			}

			pages.Add(new PageReport {
				Title = page.Title,
				Level = page.Level,
				IsDeleted = page.IsDeleted,
				IsConflictPage = page.IsConflictPage,
				CreatedUtc = page.CreatedUtc?.ToUniversalTime().ToString("o"),
				LastModifiedUtc = page.LastModifiedUtc?.ToUniversalTime().ToString("o"),
				Text = Normalize(markdown),
				Attachments = attachments,
			});
		}

		return new SectionReport {
			Name = section.Name,
			StorageFormat = section.StorageFormat.ToString(),
			Pages = pages,
			Diagnostics = section.Diagnostics.Select(d => d.Code).Distinct().ToList(),
		};
	}

	/// <summary>
	/// Reduce Markdown to the words it carries.
	///
	/// The two projects style Markdown differently — emphasis markers, link syntax,
	/// list bullets, table pipes. Comparing those would report differences that are
	/// not defects. What must agree is the text itself, so punctuation of the markup
	/// is stripped and whitespace collapsed.
	/// </summary>
	static string Normalize(string markdown) {
		var text = new StringBuilder(markdown.Length);
		foreach (var character in markdown) {
			text.Append(char.IsLetterOrDigit(character) ? char.ToLowerInvariant(character) : ' ');
		}
		return string.Join(' ', text.ToString().Split(' ', StringSplitOptions.RemoveEmptyEntries));
	}

}

class FileReport {
	public string Input { get; set; } = "";
	public bool Ok { get; set; }
	public string? Error { get; set; }
	public string? Code { get; set; }
	public List<SectionReport> Sections { get; set; } = [];
}

class SectionReport {
	public string? Name { get; set; }
	public string? StorageFormat { get; set; }
	public List<PageReport> Pages { get; set; } = [];
	public List<string> Diagnostics { get; set; } = [];
}

class PageReport {
	public string? Title { get; set; }
	public int Level { get; set; }
	public bool IsDeleted { get; set; }
	public bool IsConflictPage { get; set; }
	public string? CreatedUtc { get; set; }
	public string? LastModifiedUtc { get; set; }
	public string? Text { get; set; }
	public List<AttachmentReport> Attachments { get; set; } = [];
}

class AttachmentReport {
	public string? FileName { get; set; }
	public string? MediaType { get; set; }
	public int Bytes { get; set; }
	public string? Sha256 { get; set; }
}

[JsonSourceGenerationOptions(WriteIndented = true, DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull)]
[JsonSerializable(typeof(List<FileReport>))]
partial class JsonContext : JsonSerializerContext { }
