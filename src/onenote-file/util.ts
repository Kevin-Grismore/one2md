/*
 * Copied verbatim from obsidian-importer `src/util.ts` (MIT, Copyright (c) 2023 Obsidian).
 * Only these two functions are needed by `convert.ts`; the upstream module itself
 * imports `obsidian` at its first line, so it cannot be vendored whole.
 */

/** A usable extension from a filename, without its leading dot. */
export function extensionFromName(name: string | undefined): string | null {
	return name?.match(/\.([^.\s\\/]+)$/)?.[1] ?? null;
}

export function extensionFromBytes(bytes: Uint8Array): string | null {
	const magic = (offset: number, ...signature: number[]) =>
		signature.every((byte, i) => bytes[offset + i] === byte);

	const tag = (offset: number) =>
		String.fromCharCode(...bytes.subarray(offset, offset + 4));

	if (magic(0, 0x89, 0x50, 0x4e, 0x47)) return 'png';
	if (magic(0, 0xff, 0xd8, 0xff)) return 'jpg';
	if (magic(0, 0x47, 0x49, 0x46, 0x38)) return 'gif';
	if (magic(0, 0x25, 0x50, 0x44, 0x46)) return 'pdf';
	if (magic(0, 0x49, 0x49, 0x2a, 0x00) || magic(0, 0x4d, 0x4d, 0x00, 0x2a)) return 'tiff';
	if (magic(0, 0x42, 0x4d)) return 'bmp';
	if (magic(0, 0x1f, 0x8b)) return 'gz';
	if (magic(0, 0x49, 0x44, 0x33)) return 'mp3';

	if (tag(0) === 'RIFF') {
		if (tag(8) === 'WEBP') return 'webp';
		if (tag(8) === 'WAVE') return 'wav';
	}

	if (tag(4) === 'ftyp') {
		// ISO base media files identify their format with a brand after ftyp.
		const brand = tag(8);
		if (brand.startsWith('avi')) return 'avif';
		if (brand.startsWith('hei') || brand === 'mif1' || brand === 'msf1') return 'heic';
		if (brand.startsWith('qt')) return 'mov';
		return 'mp4';
	}

	if (magic(0, 0x50, 0x4b, 0x03, 0x04)) return 'zip';

	return null;
}
