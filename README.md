# Reliable Audio Recording Pipeline

A production-grade chunking setup that ensures recording data stays accurate in all cases — preventing data loss and silent failures.

## Architecture & Flow

```text
Client (Browser)
    │
    ├── 1. Record & chunk data on the client side
    ├── 2. Store chunks in OPFS (Origin Private File System)
    ├── 3. Upload chunks to storage bucket
    ├── 4. On success → acknowledge (ack) to the database
    │
    └── Background Recovery: 
        └── Restores missing chunks dynamically from the local OPFS cache
```

**Philosophy:** In all cases, the recording data stays accurate. OPFS acts as the durable client-side buffer — chunks are only cleared from the user's browser after the bucket and DB are both confirmed in absolute sync.

### Processing Details
1. **Client-side chunking** — Audio memory is split into WAV chunks.
2. **OPFS storage** — Each chunk is persisted to the Origin Private File System before any network call, providing resilience against tab closures.
3. **Bucket upload** — Chunks are securely uploaded to a storage bucket.
4. **DB acknowledgment** — Once the bucket confirms receipt, an idempotent ack protocol writes to the database.
5. **Autonomic Reconciliation** — Background hooks continually sweep for structural discrepancies between buckets and DB states, repairing them autonomously.

## Tech Stack

- **Next.js (App Router)** — Frontend interface
- **Hono** — Backend API server
- **Bun** — High-performance runtime
- **Drizzle ORM + PostgreSQL** — Database orchestration
- **TailwindCSS + shadcn/ui** — Reactive UI framework
- **Turborepo** — Monorepo build system

## Initialization

```bash
npm install
```

### Database Synchronization

Configure `apps/server/.env` with your PostgreSQL connection logic.

```bash
npm run db:push
```

### Local Development

Launch the environment stacks simultaneously:

```bash
npm run dev
```

- **Frontend:** [http://localhost:3001](http://localhost:3001)
- **API Edge:** [http://localhost:3000](http://localhost:3000)

## Performance 

Configured for **high concurrency**: the backend effectively buffers massive simultaneous chunk pipelines leveraging asynchronous disk access checks and PostgreSQL connection pooling natively.
