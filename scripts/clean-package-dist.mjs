#!/usr/bin/env node
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
await Promise.all([
  rm(join(repoRoot, "dist"), { recursive: true, force: true }),
  rm(join(repoRoot, "tsconfig.tsbuildinfo"), { force: true }),
]);
