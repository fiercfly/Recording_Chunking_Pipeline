/**
 * Upload Pipeline
 *
 * Manages the upload queue with retry logic, exponential backoff,
 * and reconciliation. Chunks are processed in order with a
 * configurable concurrency limit.
 */
import {
  getChunkBlob,
  getChunkMeta,
  listChunks,
  removeChunk,
  updateChunkStatus,
  type ChunkMetadata,
} from "./opfs-manager";

const SERVER_URL =
  typeof window !== "undefined"
    ? (process.env.NEXT_PUBLIC_SERVER_URL || "http://localhost:3000")
    : "http://localhost:3000";

const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1000;
const MAX_CONCURRENT = 3;

export interface PendingChunk {
  chunkId: string;
  recordingId: string;
  chunkIndex: number;
  duration: number;
  size: number;
  checksum: string;
}

export interface UploadResult {
  chunkId: string;
  ackedAt: string;
  bucketKey: string;
  alreadyExisted: boolean;
}

export interface ReconciliationResult {
  verified: string[];
  missing: string[];
  dbOnly: string[];
  reUploaded: string[];
  errors: string[];
}

export type UploadEventType =
  | "enqueued"
  | "uploading"
  | "acked"
  | "retry"
  | "failed"
  | "reconciled";

export interface UploadEvent {
  type: UploadEventType;
  chunkId: string;
  chunkIndex: number;
  recordingId: string;
  attempt?: number;
  error?: string;
}

type EventHandler = (event: UploadEvent) => void;

// ────────────────────────────────────────────────────────────
// Upload Pipeline Class
// ────────────────────────────────────────────────────────────

class UploadPipeline {
  private queue: PendingChunk[] = [];
  private activeUploads = 0;
  private processing = false;
  private handlers: EventHandler[] = [];

  /** Subscribe to upload events */
  onEvent(handler: EventHandler): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }

  private emit(event: UploadEvent): void {
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch {
        // don't let handler errors break the pipeline
      }
    }
  }

  /** Enqueue a chunk for upload */
  enqueue(chunk: PendingChunk): void {
    this.queue.push(chunk);
    this.emit({
      type: "enqueued",
      chunkId: chunk.chunkId,
      chunkIndex: chunk.chunkIndex,
      recordingId: chunk.recordingId,
    });
    this.processQueue();
  }

  /** Get current queue length */
  get queueLength(): number {
    return this.queue.length;
  }

  /** Get number of active uploads */
  get activeCount(): number {
    return this.activeUploads;
  }

  /** Process the upload queue */
  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0) {
      // Wait if we're at the concurrency limit
      if (this.activeUploads >= MAX_CONCURRENT) {
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        continue;
      }

      const chunk = this.queue.shift();
      if (!chunk) break;

      this.activeUploads++;
      // Process without awaiting to allow concurrent uploads
      this.uploadWithRetry(chunk)
        .catch(() => {
          // errors already handled inside uploadWithRetry
        })
        .finally(() => {
          this.activeUploads--;
        });
    }

    this.processing = false;
  }

  /** Upload a single chunk with exponential backoff retry */
  private async uploadWithRetry(chunk: PendingChunk): Promise<void> {
    let lastError = "";

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        this.emit({
          type: "uploading",
          chunkId: chunk.chunkId,
          chunkIndex: chunk.chunkIndex,
          recordingId: chunk.recordingId,
          attempt,
        });

        await updateChunkStatus(chunk.recordingId, chunk.chunkId, "uploading");

        // Get the blob from OPFS
        const blob = await getChunkBlob(chunk.recordingId, chunk.chunkId);
        if (!blob) {
          throw new Error("Chunk blob not found in OPFS");
        }

        // Build multipart form data
        const formData = new FormData();
        formData.append("chunkId", chunk.chunkId);
        formData.append("recordingId", chunk.recordingId);
        formData.append("chunkIndex", String(chunk.chunkIndex));
        formData.append("duration", String(chunk.duration));
        formData.append("checksum", chunk.checksum);
        formData.append("file", blob, `${chunk.chunkId}.wav`);

        const response = await fetch(`${SERVER_URL}/api/chunks/upload`, {
          method: "POST",
          body: formData,
        });

        if (!response.ok) {
          const errorBody = await response.text();
          throw new Error(`Upload failed (${response.status}): ${errorBody}`);
        }

        // Success — mark as acked
        await updateChunkStatus(chunk.recordingId, chunk.chunkId, "acked");

        this.emit({
          type: "acked",
          chunkId: chunk.chunkId,
          chunkIndex: chunk.chunkIndex,
          recordingId: chunk.recordingId,
        });

        return; // success
      } catch (err) {
        lastError = err instanceof Error ? err.message : "Unknown error";

        if (attempt < MAX_RETRIES) {
          const delay = BASE_DELAY_MS * 2 ** (attempt - 1);
          this.emit({
            type: "retry",
            chunkId: chunk.chunkId,
            chunkIndex: chunk.chunkIndex,
            recordingId: chunk.recordingId,
            attempt,
            error: lastError,
          });
          await new Promise<void>((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    // All retries exhausted
    await updateChunkStatus(chunk.recordingId, chunk.chunkId, "failed", lastError);

    this.emit({
      type: "failed",
      chunkId: chunk.chunkId,
      chunkIndex: chunk.chunkIndex,
      recordingId: chunk.recordingId,
      error: lastError,
    });
  }

  /** Recovery: scan OPFS for pending/failed chunks and re-enqueue them */
  async recover(recordingId: string): Promise<number> {
    const chunksMeta = await listChunks(recordingId);
    let recovered = 0;

    for (const meta of chunksMeta) {
      if (meta.uploadStatus === "pending" || meta.uploadStatus === "failed" || meta.uploadStatus === "uploading") {
        this.enqueue({
          chunkId: meta.chunkId,
          recordingId: meta.recordingId,
          chunkIndex: meta.chunkIndex,
          duration: meta.duration,
          size: meta.size,
          checksum: meta.checksum,
        });
        recovered++;
      }
    }

    return recovered;
  }

  /** Reconciliation: verify all acked chunks still exist in bucket */
  async reconcile(recordingId: string): Promise<ReconciliationResult> {
    const chunksMeta = await listChunks(recordingId);
    const ackedChunks = chunksMeta.filter(
      (m) => m.uploadStatus === "acked",
    );

    if (ackedChunks.length === 0) {
      return { verified: [], missing: [], dbOnly: [], reUploaded: [], errors: [] };
    }

    const chunkIds = ackedChunks.map((m) => m.chunkId);

    try {
      const response = await fetch(`${SERVER_URL}/api/chunks/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chunkIds }),
      });

      if (!response.ok) {
        throw new Error(`Verify failed: ${response.status}`);
      }

      const result = await response.json() as {
        verified: string[];
        missing: string[];
        dbOnly: string[];
      };

      const reUploaded: string[] = [];
      const errors: string[] = [];

      // Re-upload chunks that are in DB but missing from bucket
      for (const chunkId of result.dbOnly) {
        try {
          const meta = await getChunkMeta(recordingId, chunkId);
          if (meta) {
            this.enqueue({
              chunkId: meta.chunkId,
              recordingId: meta.recordingId,
              chunkIndex: meta.chunkIndex,
              duration: meta.duration,
              size: meta.size,
              checksum: meta.checksum,
            });
            reUploaded.push(chunkId);
          }
        } catch (err) {
          errors.push(`Failed to re-upload ${chunkId}: ${err instanceof Error ? err.message : "Unknown"}`);
        }
      }

      // Also re-upload chunks not in DB at all
      for (const chunkId of result.missing) {
        try {
          const meta = await getChunkMeta(recordingId, chunkId);
          if (meta) {
            await updateChunkStatus(recordingId, chunkId, "pending");
            this.enqueue({
              chunkId: meta.chunkId,
              recordingId: meta.recordingId,
              chunkIndex: meta.chunkIndex,
              duration: meta.duration,
              size: meta.size,
              checksum: meta.checksum,
            });
            reUploaded.push(chunkId);
          }
        } catch (err) {
          errors.push(`Failed to re-upload ${chunkId}: ${err instanceof Error ? err.message : "Unknown"}`);
        }
      }

      // Clean up fully verified chunks from OPFS
      for (const chunkId of result.verified) {
        await removeChunk(recordingId, chunkId);
      }

      this.emit({
        type: "reconciled",
        chunkId: "",
        chunkIndex: -1,
        recordingId,
      });

      return {
        verified: result.verified,
        missing: result.missing,
        dbOnly: result.dbOnly,
        reUploaded,
        errors,
      };
    } catch (err) {
      return {
        verified: [],
        missing: [],
        dbOnly: [],
        reUploaded: [],
        errors: [err instanceof Error ? err.message : "Unknown error"],
      };
    }
  }
}

// Singleton instance
export const uploadPipeline = new UploadPipeline();
