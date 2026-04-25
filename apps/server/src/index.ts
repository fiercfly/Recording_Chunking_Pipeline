import { serve } from "@hono/node-server";
import { env } from "@my-better-t-app/env/server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import chunksRoutes from "./routes/chunks";
import recordingsRoutes from "./routes/recordings";

const app = new Hono();

app.use(logger());
app.use(
  "/*",
  cors({
    origin: env.CORS_ORIGIN,
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  }),
);

// Health check
app.get("/", (c) => {
  return c.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Mount routes
app.route("/api/recordings", recordingsRoutes);
app.route("/api/chunks", chunksRoutes);

const port = 3000;
console.log(`Server starting on port ${port}...`);

serve({
  fetch: app.fetch,
  port,
});

export default app;
