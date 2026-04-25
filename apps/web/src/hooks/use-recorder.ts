import { useCallback, useEffect, useRef, useState } from "react";
import {
  isOPFSAvailable,
  listChunks,
  listRecordings,
  saveChunk as saveChunkToOPFS,
  saveRecordingMeta,
  type ChunkMetadata,
} from "@/lib/opfs-manager";
import {
  uploadPipeline,
  type UploadEvent,
} from "@/lib/upload-pipeline";

const SAMPLE_RATE = 16000;
const BUFFER_SIZE = 4096;

const SERVER_URL = process.env.NEXT_PUBLIC_SERVER_URL || "http://localhost:3000";

export interface WavChunk {
  id: string;
  blob: Blob;
  url: string;
  duration: number;
  timestamp: number;
  chunkIndex: number;
  checksum: string;
  uploadStatus: ChunkMetadata["uploadStatus"];
}

export type RecorderStatus = "idle" | "requesting" | "recording" | "paused";

interface UseRecorderOptions {
  chunkDuration?: number;
  deviceId?: string;
}

function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, samples.length * 2, true);

  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }

  return new Blob([buffer], { type: "audio/wav" });
}

function resample(
  input: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const length = Math.round(input.length / ratio);
  const output = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const srcIndex = i * ratio;
    const low = Math.floor(srcIndex);
    const high = Math.min(low + 1, input.length - 1);
    const frac = srcIndex - low;
    output[i] = (input[low] ?? 0) * (1 - frac) + (input[high] ?? 0) * frac;
  }
  return output;
}

/** Compute SHA-256 checksum of a blob */
async function computeChecksum(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function useRecorder(options: UseRecorderOptions = {}) {
  const { chunkDuration = 5, deviceId } = options;

  const [status, setStatus] = useState<RecorderStatus>("idle");
  const [chunks, setChunks] = useState<WavChunk[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [uploadEvents, setUploadEvents] = useState<UploadEvent[]>([]);
  const [pendingRecovery, setPendingRecovery] = useState(0);
  const [opfsAvailable, setOpfsAvailable] = useState(false);

  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const samplesRef = useRef<Float32Array[]>([]);
  const sampleCountRef = useRef(0);
  const chunkThreshold = SAMPLE_RATE * chunkDuration;
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef(0);
  const pausedElapsedRef = useRef(0);
  const statusRef = useRef<RecorderStatus>("idle");
  const chunkIndexRef = useRef(0);
  const recordingIdRef = useRef<string | null>(null);

  statusRef.current = status;

  // Check OPFS availability on mount
  useEffect(() => {
    setOpfsAvailable(isOPFSAvailable());
  }, []);

  // Subscribe to upload events
  useEffect(() => {
    const unsubscribe = uploadPipeline.onEvent((event) => {
      setUploadEvents((prev) => [...prev.slice(-100), event]);

      // Update chunk upload status in our local state
      if (event.type === "acked" || event.type === "failed" || event.type === "uploading") {
        setChunks((prev) =>
          prev.map((c) =>
            c.id === event.chunkId
              ? { ...c, uploadStatus: event.type === "acked" ? "acked" : event.type === "failed" ? "failed" : "uploading" }
              : c,
          ),
        );
      }
    });

    return unsubscribe;
  }, []);

  // Recovery: check for pending uploads from previous sessions
  useEffect(() => {
    if (!opfsAvailable) return;

    const attemptRecovery = async () => {
      try {
        const recordingIds = await listRecordings();
        let totalPending = 0;

        for (const id of recordingIds) {
          const chunksMeta = await listChunks(id);
          const pending = chunksMeta.filter(
            (m) =>
              m.uploadStatus === "pending" ||
              m.uploadStatus === "failed" ||
              m.uploadStatus === "uploading",
          );
          if (pending.length > 0) {
            const recovered = await uploadPipeline.recover(id);
            totalPending += recovered;
          }
        }

        setPendingRecovery(totalPending);
      } catch {
        // recovery is best-effort
      }
    };

    attemptRecovery();
  }, [opfsAvailable]);

  const produceChunk = useCallback(
    async (merged: Float32Array) => {
      const currentRecordingId = recordingIdRef.current;
      if (!currentRecordingId) return;

      const blob = encodeWav(merged, SAMPLE_RATE);
      const url = URL.createObjectURL(blob);
      const chunkId = crypto.randomUUID();
      const currentIndex = chunkIndexRef.current;
      chunkIndexRef.current++;

      const checksum = await computeChecksum(blob);
      const duration = merged.length / SAMPLE_RATE;

      const chunk: WavChunk = {
        id: chunkId,
        blob,
        url,
        duration,
        timestamp: Date.now(),
        chunkIndex: currentIndex,
        checksum,
        uploadStatus: "pending",
      };

      // Memory Optimization: Keep only the latest 40 blobs in memory.
      // Older chunks are kept in the array for stats, but their blob/URL is released.
      setChunks((prev) => {
        const next = [...prev, chunk];
        if (next.length > 40) {
          const oldIndex = next.length - 41;
          const oldChunk = next[oldIndex];
          if (oldChunk && oldChunk.url) {
            URL.revokeObjectURL(oldChunk.url);
            // Replace with lightweight version to prevent RAM bloat on 1-hour+ recordings
            next[oldIndex] = { ...oldChunk, blob: null as any, url: "" };
          }
        }
        return next;
      });

      // Persist to OPFS FIRST — before any network call

      if (opfsAvailable) {
        try {
          await saveChunkToOPFS(currentRecordingId, chunkId, blob, {
            chunkId,
            recordingId: currentRecordingId,
            chunkIndex: currentIndex,
            duration,
            size: blob.size,
            checksum,
            timestamp: Date.now(),
          });
        } catch (err) {
          console.error("Failed to save chunk to OPFS:", err);
        }
      }

      // Enqueue for upload
      uploadPipeline.enqueue({
        chunkId,
        recordingId: currentRecordingId,
        chunkIndex: currentIndex,
        duration,
        size: blob.size,
        checksum,
      });
    },
    [opfsAvailable],
  );

  const flushChunk = useCallback(() => {
    if (samplesRef.current.length === 0) return;

    const totalLen = samplesRef.current.reduce((n, b) => n + b.length, 0);
    const merged = new Float32Array(totalLen);
    let offset = 0;
    for (const buf of samplesRef.current) {
      merged.set(buf, offset);
      offset += buf.length;
    }
    samplesRef.current = [];
    sampleCountRef.current = 0;

    produceChunk(merged);
  }, [produceChunk]);

  const start = useCallback(async () => {
    if (statusRef.current === "recording") return;

    setStatus("requesting");
    try {
      // Create recording session on server
      const response = await fetch(`${SERVER_URL}/api/recordings`, {
        method: "POST",
      });

      if (!response.ok) {
        throw new Error(`Failed to create recording: ${response.status}`);
      }

      const data = await response.json() as { id: string };
      const newRecordingId = data.id;
      setRecordingId(newRecordingId);
      recordingIdRef.current = newRecordingId;
      chunkIndexRef.current = 0;

      // Save recording metadata to OPFS
      if (opfsAvailable) {
        await saveRecordingMeta({
          recordingId: newRecordingId,
          createdAt: Date.now(),
          status: "recording",
        });
      }

      const mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: deviceId
          ? {
              deviceId: { exact: deviceId },
              echoCancellation: true,
              noiseSuppression: true,
            }
          : { echoCancellation: true, noiseSuppression: true },
      });

      const audioCtx = new AudioContext();
      const source = audioCtx.createMediaStreamSource(mediaStream);
      const processor = audioCtx.createScriptProcessor(BUFFER_SIZE, 1, 1);
      const nativeSampleRate = audioCtx.sampleRate;

      processor.onaudioprocess = (e) => {
        if (statusRef.current !== "recording") return;

        const input = e.inputBuffer.getChannelData(0);
        const resampled = resample(
          new Float32Array(input),
          nativeSampleRate,
          SAMPLE_RATE,
        );

        samplesRef.current.push(resampled);
        sampleCountRef.current += resampled.length;

        if (sampleCountRef.current >= chunkThreshold) {
          const totalLen = samplesRef.current.reduce(
            (n, b) => n + b.length,
            0,
          );
          const merged = new Float32Array(totalLen);
          let off = 0;
          for (const buf of samplesRef.current) {
            merged.set(buf, off);
            off += buf.length;
          }
          samplesRef.current = [];
          sampleCountRef.current = 0;

          produceChunk(merged);
        }
      };

      source.connect(processor);
      processor.connect(audioCtx.destination);

      streamRef.current = mediaStream;
      audioCtxRef.current = audioCtx;
      processorRef.current = processor;
      setStream(mediaStream);

      samplesRef.current = [];
      sampleCountRef.current = 0;
      pausedElapsedRef.current = 0;
      startTimeRef.current = Date.now();
      setElapsed(0);
      setChunks([]);
      setUploadEvents([]);
      setStatus("recording");

      timerRef.current = setInterval(() => {
        if (statusRef.current === "recording") {
          setElapsed(
            pausedElapsedRef.current +
              (Date.now() - startTimeRef.current) / 1000,
          );
        }
      }, 100);
    } catch {
      setStatus("idle");
    }
  }, [deviceId, chunkThreshold, produceChunk, opfsAvailable]);

  const stop = useCallback(async () => {
    flushChunk();

    processorRef.current?.disconnect();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    if (audioCtxRef.current?.state !== "closed") {
      audioCtxRef.current?.close();
    }
    if (timerRef.current) clearInterval(timerRef.current);

    processorRef.current = null;
    audioCtxRef.current = null;
    streamRef.current = null;
    setStream(null);
    setStatus("idle");

    // Mark recording as completed on server
    const currentRecordingId = recordingIdRef.current;
    if (currentRecordingId) {
      try {
        await fetch(
          `${SERVER_URL}/api/recordings/${currentRecordingId}/complete`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              totalChunks: chunkIndexRef.current,
              totalDuration: elapsed,
            }),
          },
        );
      } catch {
        // best-effort marking
      }
    }
  }, [flushChunk, elapsed]);

  const pause = useCallback(() => {
    if (statusRef.current !== "recording") return;
    pausedElapsedRef.current += (Date.now() - startTimeRef.current) / 1000;
    setStatus("paused");
  }, []);

  const resume = useCallback(() => {
    if (statusRef.current !== "paused") return;
    startTimeRef.current = Date.now();
    setStatus("recording");
  }, []);

  const clearChunks = useCallback(() => {
    for (const c of chunks) URL.revokeObjectURL(c.url);
    setChunks([]);
  }, [chunks]);

  /** Manually trigger reconciliation for the current recording */
  const reconcile = useCallback(async () => {
    const currentRecordingId = recordingIdRef.current;
    if (!currentRecordingId) return null;
    return uploadPipeline.reconcile(currentRecordingId);
  }, []);

  /** Retry all failed uploads for the current recording */
  const retryFailed = useCallback(async () => {
    const currentRecordingId = recordingIdRef.current;
    if (!currentRecordingId) return 0;
    return uploadPipeline.recover(currentRecordingId);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      processorRef.current?.disconnect();
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (audioCtxRef.current?.state !== "closed") {
        audioCtxRef.current?.close();
      }
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  // Periodic background reconciliation for long recordings
  useEffect(() => {
    if (!opfsAvailable || !recordingIdRef.current) return;

    // Run reconciliation every 60 seconds to clear acked chunks from OPFS
    const interval = setInterval(() => {
      // Reconcile to free up OPFS storage during long sessions
      if (uploadPipeline.activeCount === 0) {
        uploadPipeline.reconcile(recordingIdRef.current as string).catch(() => {
          // ignore background reconcile errors
        });
      }
    }, 60000);

    return () => clearInterval(interval);
  }, [opfsAvailable]);

  // Compute upload stats
  const uploadStats = {
    total: chunks.length,
    pending: chunks.filter((c) => c.uploadStatus === "pending").length,
    uploading: chunks.filter((c) => c.uploadStatus === "uploading").length,
    acked: chunks.filter((c) => c.uploadStatus === "acked").length,
    failed: chunks.filter((c) => c.uploadStatus === "failed").length,
  };

  return {
    status,
    start,
    stop,
    pause,
    resume,
    chunks,
    elapsed,
    stream,
    clearChunks,
    recordingId,
    uploadStats,
    uploadEvents,
    pendingRecovery,
    opfsAvailable,
  };
}
