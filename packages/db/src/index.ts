import { env } from "@my-better-t-app/env/server";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import * as schema from "./schema";

const { Pool } = pg;

export function createDb() {
  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    max: 100, // Maximum connections for load testing
  });
  return drizzle(pool, { schema });
}

export const db = createDb();

export { recordings, recordingStatusEnum, chunks, chunkStatusEnum } from "./schema/chunks";
export { recordingsRelations, chunksRelations } from "./schema/relations";
