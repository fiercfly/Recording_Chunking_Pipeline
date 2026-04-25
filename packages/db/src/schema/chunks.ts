import { integer, pgEnum, pgTable, real, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const recordingStatusEnum = pgEnum("recording_status", [
  "recording",
  "completed",
  "failed",
]);

export const recordings = pgTable("recordings", {
  id: uuid("id").primaryKey().defaultRandom(),
  status: recordingStatusEnum("status").notNull().default("recording"),
  totalChunks: integer("total_chunks"),
  totalDuration: real("total_duration"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),
});

export const chunkStatusEnum = pgEnum("chunk_status", [
  "uploaded",
  "acked",
]);

export const chunks = pgTable("chunks", {
  id: uuid("id").primaryKey(),
  recordingId: uuid("recording_id")
    .notNull()
    .references(() => recordings.id, { onDelete: "cascade" }),
  chunkIndex: integer("chunk_index").notNull(),
  bucketKey: text("bucket_key").notNull(),
  size: integer("size").notNull(),
  duration: real("duration").notNull(),
  checksum: text("checksum").notNull(),
  status: chunkStatusEnum("status").notNull().default("uploaded"),
  ackedAt: timestamp("acked_at").notNull().defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
