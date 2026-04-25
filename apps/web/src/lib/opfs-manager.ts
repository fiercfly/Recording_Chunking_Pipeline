/**
 * OPFS (Origin Private File System) Manager
 *
 * Provides durable client-side storage for recording chunks.
 * Chunks are persisted to OPFS BEFORE any network call, so nothing
 * is lost if the tab closes or the network drops.
 *
 * Directory structure:
 *   /recordings/{recordingId}/metadata.json
 *   /recordings/{recordingId}/chunks/{chunkId}.wav
 *   /recordings/{recordingId}/chunks/{chunkId}.meta.json
 */

export interface ChunkMetadata {
  chunkId: string;
  recordingId: string;
  chunkIndex: number;
  duration: number;
  size: number;
  checksum: string;
  timestamp: number;
  uploadStatus: "pending" | "uploading" | "acked" | "failed";
  error?: string;
}

export interface RecordingMetadata {
  recordingId: string;
  createdAt: number;
  status: "recording" | "completed" | "failed";
  totalChunks?: number;
}

async function getRoot(): Promise<FileSystemDirectoryHandle> {
  return navigator.storage.getDirectory();
}

async function getOrCreateDir(
  parent: FileSystemDirectoryHandle,
  name: string,
): Promise<FileSystemDirectoryHandle> {
  return parent.getDirectoryHandle(name, { create: true });
}

async function getRecordingsDir(): Promise<FileSystemDirectoryHandle> {
  const root = await getRoot();
  return getOrCreateDir(root, "recordings");
}

async function getRecordingDir(
  recordingId: string,
): Promise<FileSystemDirectoryHandle> {
  const recordingsDir = await getRecordingsDir();
  return getOrCreateDir(recordingsDir, recordingId);
}

async function getChunksDir(
  recordingId: string,
): Promise<FileSystemDirectoryHandle> {
  const recordingDir = await getRecordingDir(recordingId);
  return getOrCreateDir(recordingDir, "chunks");
}

async function writeJSON(
  dir: FileSystemDirectoryHandle,
  filename: string,
  data: unknown,
): Promise<void> {
  const fileHandle = await dir.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(JSON.stringify(data));
  await writable.close();
}

async function readJSON<T>(
  dir: FileSystemDirectoryHandle,
  filename: string,
): Promise<T | null> {
  try {
    const fileHandle = await dir.getFileHandle(filename);
    const file = await fileHandle.getFile();
    const text = await file.text();
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

async function writeBlob(
  dir: FileSystemDirectoryHandle,
  filename: string,
  blob: Blob,
): Promise<void> {
  const fileHandle = await dir.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(blob);
  await writable.close();
}

async function readBlob(
  dir: FileSystemDirectoryHandle,
  filename: string,
): Promise<Blob | null> {
  try {
    const fileHandle = await dir.getFileHandle(filename);
    return fileHandle.getFile();
  } catch {
    return null;
  }
}

// ────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────

/** Check if OPFS is available */
export function isOPFSAvailable(): boolean {
  return typeof navigator !== "undefined" && "storage" in navigator && "getDirectory" in navigator.storage;
}

/** Save recording metadata */
export async function saveRecordingMeta(meta: RecordingMetadata): Promise<void> {
  const dir = await getRecordingDir(meta.recordingId);
  await writeJSON(dir, "metadata.json", meta);
}

/** Get recording metadata */
export async function getRecordingMeta(
  recordingId: string,
): Promise<RecordingMetadata | null> {
  const dir = await getRecordingDir(recordingId);
  return readJSON<RecordingMetadata>(dir, "metadata.json");
}

/** Save a chunk blob + metadata to OPFS — called BEFORE any network call */
export async function saveChunk(
  recordingId: string,
  chunkId: string,
  blob: Blob,
  metadata: Omit<ChunkMetadata, "uploadStatus">,
): Promise<void> {
  const chunksDir = await getChunksDir(recordingId);
  await writeBlob(chunksDir, `${chunkId}.wav`, blob);
  await writeJSON(chunksDir, `${chunkId}.meta.json`, {
    ...metadata,
    uploadStatus: "pending",
  });
}

/** Read a chunk blob from OPFS */
export async function getChunkBlob(
  recordingId: string,
  chunkId: string,
): Promise<Blob | null> {
  const chunksDir = await getChunksDir(recordingId);
  return readBlob(chunksDir, `${chunkId}.wav`);
}

/** Read chunk metadata */
export async function getChunkMeta(
  recordingId: string,
  chunkId: string,
): Promise<ChunkMetadata | null> {
  const chunksDir = await getChunksDir(recordingId);
  return readJSON<ChunkMetadata>(chunksDir, `${chunkId}.meta.json`);
}

/** Update chunk upload status */
export async function updateChunkStatus(
  recordingId: string,
  chunkId: string,
  status: ChunkMetadata["uploadStatus"],
  error?: string,
): Promise<void> {
  const chunksDir = await getChunksDir(recordingId);
  const meta = await readJSON<ChunkMetadata>(chunksDir, `${chunkId}.meta.json`);
  if (meta) {
    meta.uploadStatus = status;
    if (error) meta.error = error;
    await writeJSON(chunksDir, `${chunkId}.meta.json`, meta);
  }
}

/** List all chunks for a recording */
export async function listChunks(
  recordingId: string,
): Promise<ChunkMetadata[]> {
  const chunksDir = await getChunksDir(recordingId);
  const metaList: ChunkMetadata[] = [];

  for await (const [name] of chunksDir as any) {
    if (name.endsWith(".meta.json")) {
      const meta = await readJSON<ChunkMetadata>(chunksDir, name);
      if (meta) metaList.push(meta);
    }
  }

  return metaList.sort((a, b) => a.chunkIndex - b.chunkIndex);
}

/** List all recording IDs in OPFS */
export async function listRecordings(): Promise<string[]> {
  try {
    const recordingsDir = await getRecordingsDir();
    const ids: string[] = [];

    for await (const [name, handle] of recordingsDir as any) {
      if (handle.kind === "directory") {
        ids.push(name);
      }
    }

    return ids;
  } catch {
    return [];
  }
}

/** Remove a single chunk from OPFS */
export async function removeChunk(
  recordingId: string,
  chunkId: string,
): Promise<void> {
  const chunksDir = await getChunksDir(recordingId);
  try {
    await chunksDir.removeEntry(`${chunkId}.wav`);
  } catch { /* already gone */ }
  try {
    await chunksDir.removeEntry(`${chunkId}.meta.json`);
  } catch { /* already gone */ }
}

/** Remove an entire recording from OPFS */
export async function removeRecording(recordingId: string): Promise<void> {
  try {
    const recordingsDir = await getRecordingsDir();
    await recordingsDir.removeEntry(recordingId, { recursive: true });
  } catch { /* already gone */ }
}

/** Get OPFS usage statistics */
export async function getStats(): Promise<{
  totalRecordings: number;
  totalChunks: number;
  totalBytes: number;
  pendingChunks: number;
}> {
  const recordingIds = await listRecordings();
  let totalChunks = 0;
  let totalBytes = 0;
  let pendingChunks = 0;

  for (const recordingId of recordingIds) {
    const chunksMeta = await listChunks(recordingId);
    totalChunks += chunksMeta.length;

    for (const meta of chunksMeta) {
      totalBytes += meta.size;
      if (meta.uploadStatus === "pending" || meta.uploadStatus === "failed") {
        pendingChunks++;
      }
    }
  }

  return {
    totalRecordings: recordingIds.length,
    totalChunks,
    totalBytes,
    pendingChunks,
  };
}
