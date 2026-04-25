import "dotenv/config";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  server: {
    DATABASE_URL: z.string().min(1),
    CORS_ORIGIN: z.url(),
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    UPLOAD_DIR: z.string().default("./uploads"),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
