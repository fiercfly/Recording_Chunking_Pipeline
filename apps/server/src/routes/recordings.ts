import { db, recordings } from "@my-better-t-app/db";
import { eq } from "drizzle-orm";
import { Hono } from "hono";

const app = new Hono();

// Create a new recording session
app.post("/", async (c) => {
  try {
    const result = await db
      .insert(recordings)
      .values({ status: "recording" })
      .returning({ id: recordings.id, createdAt: recordings.createdAt });

    const recording = result[0];
    if (!recording) {
      return c.json({ error: "Failed to create recording" }, 500);
    }

    return c.json({
      id: recording.id,
      createdAt: recording.createdAt,
      status: "recording",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return c.json({ error: `Failed to create recording: ${message}` }, 500);
  }
});

// Get recording status and chunk count
app.get("/:id", async (c) => {
  const id = c.req.param("id");

  try {
    const result = await db.query.recordings.findFirst({
      where: eq(recordings.id, id),
      with: { },
    });

    if (!result) {
      return c.json({ error: "Recording not found" }, 404);
    }

    return c.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return c.json({ error: `Failed to get recording: ${message}` }, 500);
  }
});

// Mark recording as completed
app.patch("/:id/complete", async (c) => {
  const id = c.req.param("id");

  try {
    const body = await c.req.json<{ totalChunks?: number; totalDuration?: number }>();

    const result = await db
      .update(recordings)
      .set({
        status: "completed",
        totalChunks: body.totalChunks,
        totalDuration: body.totalDuration,
        completedAt: new Date(),
      })
      .where(eq(recordings.id, id))
      .returning();

    const recording = result[0];
    if (!recording) {
      return c.json({ error: "Recording not found" }, 404);
    }

    return c.json(recording);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return c.json({ error: `Failed to complete recording: ${message}` }, 500);
  }
});

// List all recordings
app.get("/", async (c) => {
  try {
    const result = await db.query.recordings.findMany({
      orderBy: (recordings, { desc }) => [desc(recordings.createdAt)],
      limit: 50,
    });

    return c.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return c.json({ error: `Failed to list recordings: ${message}` }, 500);
  }
});

export default app;
