import { relations } from "drizzle-orm";
import { chunks, recordings } from "./chunks";

export const recordingsRelations = relations(recordings, ({ many }) => ({
  chunks: many(chunks),
}));

export const chunksRelations = relations(chunks, ({ one }) => ({
  recording: one(recordings, {
    fields: [chunks.recordingId],
    references: [recordings.id],
  }),
}));
