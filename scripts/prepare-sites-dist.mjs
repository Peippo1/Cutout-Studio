import { cp, mkdir } from "node:fs/promises";
import path from "node:path";

const projectRoot = process.cwd();
const distDir = path.join(projectRoot, "dist");

const copyTargets = [
  ["server", "server"],
  ["src", "src"],
  ["vendor", "vendor"],
  [".openai", ".openai"],
];

await mkdir(distDir, { recursive: true });

for (const [from, to] of copyTargets) {
  await cp(path.join(projectRoot, from), path.join(distDir, to), {
    recursive: true,
    force: true,
  });
}
