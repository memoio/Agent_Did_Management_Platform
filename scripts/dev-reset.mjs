import { rename, stat } from "node:fs/promises";
import { resolve } from "node:path";

const data = resolve(".data");
try {
  await stat(data);
  const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const backup = resolve(".data-backup-" + stamp);
  await rename(data, backup);
  process.stdout.write(JSON.stringify({ reset: true, backup }) + "\n");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  process.stdout.write(JSON.stringify({ reset: true, backup: null }) + "\n");
}
