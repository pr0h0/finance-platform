// File contents (attachments, import sources) are kept in the `blobs` table as bytes + type, not as
// Blob values: WebKit's ephemeral sessions (Safari private windows) refuse Blobs in IndexedDB
// ("Error preparing Blob/File data to be stored in object store"). Older rows may still hold a Blob.
export interface StoredBlob {
  bytes: ArrayBuffer;
  type: string;
}

export async function toStored(b: Blob): Promise<StoredBlob> {
  return { bytes: await b.arrayBuffer(), type: b.type };
}

export function fromStored(v: Blob | StoredBlob): Blob {
  return v instanceof Blob ? v : new Blob([v.bytes], { type: v.type });
}
