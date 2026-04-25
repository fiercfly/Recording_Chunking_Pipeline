import { access, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "@my-better-t-app/env/server";

const uploadDir = path.resolve(env.UPLOAD_DIR);

const createdDirs = new Set<string>();

async function ensureDir(dirPath: string): Promise<void> {
  if (!createdDirs.has(dirPath)) {
    await mkdir(dirPath, { recursive: true });
    createdDirs.add(dirPath);
  }
}

// Ensure upload directory exists on module load
ensureDir(uploadDir).catch(console.error);

function keyToPath(key: string): string {
  return path.join(uploadDir, key);
}

export async function saveChunk(key: string, data: Buffer | Uint8Array): Promise<void> {
  const filePath = keyToPath(key);
  const dir = path.dirname(filePath);
  await ensureDir(dir);
  await writeFile(filePath, data);
}

export async function getChunk(key: string): Promise<Buffer> {
  const filePath = keyToPath(key);
  return readFile(filePath);
}

export async function chunkExists(key: string): Promise<boolean> {
  const filePath = keyToPath(key);
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function deleteChunk(key: string): Promise<void> {
  const filePath = keyToPath(key);
  try {
    await unlink(filePath);
  } catch {
    // ignore
  }
}
