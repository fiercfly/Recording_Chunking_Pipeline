import { createHash } from "node:crypto";
import { db, chunks } from "@my-better-t-app/db";
import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { chunkExists, saveChunk } from "../storage";

const app = new Hono();

// Upload a single chunk — idempotent
app.post("/upload", async (c) => {
  try {
    const formData = await c.req.formData();

    const chunkId = formData.get("chunkId") as string | null;
    const recordingId = formData.get("recordingId") as string | null;
    const chunkIndex = formData.get("chunkIndex") as string | null;
    const duration = formData.get("duration") as string | null;
    const clientChecksum = formData.get("checksum") as string | null;
    const file = formData.get("file") as File | null;

    if (!chunkId || !recordingId || !chunkIndex || !duration || !file) {
      return c.json(
        { error: "Missing required fields: chunkId, recordingId, chunkIndex, duration, file" },
        400,
      );
    }

    // Check if already acked — idempotent
    const existing = await db.query.chunks.findFirst({
      where: eq(chunks.id, chunkId),
    });

    if (existing) {
      return c.json({
        chunkId: existing.id,
        ackedAt: existing.ackedAt,
        bucketKey: existing.bucketKey,
        alreadyExisted: true,
      });
    }

    // Read file data
    const arrayBuffer = await file.arrayBuffer();
    const data = new Uint8Array(arrayBuffer);

    // Compute server-side checksum
    const serverChecksum = createHash("sha256").update(data).digest("hex");

    // Verify checksum if client provided one
    if (clientChecksum && clientChecksum !== serverChecksum) {
      return c.json(
        {
          error: "Checksum mismatch",
          expected: clientChecksum,
          got: serverChecksum,
        },
        400,
      );
    }

    // Save to bucket
    const bucketKey = `${recordingId}/${chunkId}.wav`;
    await saveChunk(bucketKey, data);

    // Write ack to database
    const result = await db
      .insert(chunks)
      .values({
        id: chunkId,
        recordingId,
        chunkIndex: Number.parseInt(chunkIndex, 10),
        bucketKey,
        size: data.byteLength,
        duration: Number.parseFloat(duration),
        checksum: serverChecksum,
        status: "acked",
      })
      .onConflictDoNothing()
      .returning({
        id: chunks.id,
        ackedAt: chunks.ackedAt,
        bucketKey: chunks.bucketKey,
      });

    let ack = result[0];
    let alreadyExisted = false;

    if (!ack) {
      const existingConflicted = await db.query.chunks.findFirst({
        where: eq(chunks.id, chunkId),
      });
      
      if (existingConflicted) {
        ack = {
          id: existingConflicted.id,
          ackedAt: existingConflicted.ackedAt,
          bucketKey: existingConflicted.bucketKey,
        };
        alreadyExisted = true;
      } else {
        return c.json({ error: "Failed to write ack" }, 500);
      }
    }

    return c.json({
      chunkId: ack.id,
      ackedAt: ack.ackedAt,
      bucketKey: ack.bucketKey,
      alreadyExisted,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return c.json({ error: `Upload failed: ${message}` }, 500);
  }
});

// Verify a batch of chunks exist in bucket
app.post("/verify", async (c) => {
  try {
    const body = await c.req.json<{ chunkIds: string[] }>();

    if (!body.chunkIds || !Array.isArray(body.chunkIds)) {
      return c.json({ error: "chunkIds array required" }, 400);
    }

    // Get all acked chunks from DB
    const ackedChunks = await db.query.chunks.findMany({
      where: inArray(chunks.id, body.chunkIds),
    });

    const verified: string[] = [];
    const missing: string[] = [];
    const dbOnly: string[] = [];

    for (const chunk of ackedChunks) {
      const inBucket = await chunkExists(chunk.bucketKey);
      if (inBucket) {
        verified.push(chunk.id);
      } else {
        // DB has ack but bucket is missing — needs re-upload
        dbOnly.push(chunk.id);
      }
    }

    // Chunks not even in DB
    const ackedIds = new Set(ackedChunks.map((ch) => ch.id));
    for (const id of body.chunkIds) {
      if (!ackedIds.has(id)) {
        missing.push(id);
      }
    }

    return c.json({ verified, missing, dbOnly });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return c.json({ error: `Verification failed: ${message}` }, 500);
  }
});

// Check single chunk status
app.get("/:id/status", async (c) => {
  const id = c.req.param("id");

  try {
    const chunk = await db.query.chunks.findFirst({
      where: eq(chunks.id, id),
    });

    if (!chunk) {
      return c.json({ acked: false, inBucket: false });
    }

    const inBucket = await chunkExists(chunk.bucketKey);

    return c.json({
      acked: true,
      inBucket,
      chunkIndex: chunk.chunkIndex,
      size: chunk.size,
      ackedAt: chunk.ackedAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return c.json({ error: `Status check failed: ${message}` }, 500);
  }
});

// Get all chunks for a recording
app.get("/by-recording/:recordingId", async (c) => {
  const recordingId = c.req.param("recordingId");

  try {
    const result = await db.query.chunks.findMany({
      where: eq(chunks.recordingId, recordingId),
      orderBy: (chunks, { asc }) => [asc(chunks.chunkIndex)],
    });

    return c.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return c.json({ error: `Failed to get chunks: ${message}` }, 500);
  }
});

export default app;
