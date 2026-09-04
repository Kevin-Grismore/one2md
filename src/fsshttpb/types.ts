/** Stream object types used by an MS-FSSHTTPB data element package. */
export enum StreamObject {
	/** An object declared as living in a separate blob element, not inline. */
	ObjectGroupObjectDeclareBlobReference = 0x05,
	/** The payload of a standalone object-data BLOB element. */
	ObjectDataBlob = 0x02,
	StorageManifestRootDeclare = 0x07,
	RevisionManifestRootDeclare = 0x0a,
	CellManifestCurrentRevision = 0x0b,
	StorageManifestSchemaGuid = 0x0c,
	StorageIndexRevisionMapping = 0x0d,
	StorageIndexCellMapping = 0x0e,
	StorageIndexManifestMapping = 0x11,
	DataElementPackage = 0x15,
	ObjectGroupObjectData = 0x16,
	ObjectGroupObjectDeclare = 0x18,
	ObjectGroupObjectDataBlobReference = 0x1c,
	RevisionManifestObjectGroupReference = 0x19,
	RevisionManifest = 0x1a,
	ObjectGroupDeclarations = 0x1d,
	ObjectGroupData = 0x1e,
	Packaging = 0x7a,
}

/**
 * Object partitions, from [MS-ONESTORE] 2.7.1.
 *
 * A OneNote object is split across partitions of one object group: its type
 * code in one, its serialized property set in another. Reassembling those two
 * is what produces something the existing revision-store reader would
 * recognise.
 */
export enum Partition {
	/** The object's serialized property set. */
	ObjectData = 1,
	/** Names the data element holding a file the page embeds. */
	ObjectFileData = 2,
	/** Four bytes: the object's JCID. */
	ObjectMetadata = 4,
}
