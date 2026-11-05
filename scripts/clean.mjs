import { rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(".");
for (const relative of ["dist", "coverage"]) {
  const target = resolve(relative);
  if (!target.startsWith(root + "/")) throw new Error("UNSAFE_CLEAN_TARGET");
  await rm(target, { recursive: true, force: true });
}
