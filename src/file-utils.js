import path from "node:path";
import { readdir } from "node:fs/promises";

const IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".tif",
  ".tiff",
  ".gif",
  ".avif",
  ".heic",
  ".heif",
]);

export function isImageFile(filePath) {
  return IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export async function collectImageFiles(rootDir, { recursive = false } = {}) {
  const entries = await readdir(rootDir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = path.join(rootDir, entry.name);

    if (entry.isDirectory()) {
      if (recursive) {
        files.push(...(await collectImageFiles(entryPath, { recursive })));
      }

      continue;
    }

    if (entry.isFile() && isImageFile(entryPath)) {
      files.push(entryPath);
    }
  }

  return files.sort();
}

export function toOutputPngPath(inputPath, outputTarget, rootInputDir) {
  const outputPath = outputTarget
    ? path.resolve(outputTarget)
    : path.resolve(path.dirname(inputPath));

  const parsed = path.parse(inputPath);

  if (!outputTarget) {
    return path.join(outputPath, `${parsed.name}.transparent.png`);
  }

  if (path.extname(outputPath).toLowerCase() === ".png") {
    return outputPath;
  }

  const relativeInput = rootInputDir
    ? path.relative(path.resolve(rootInputDir), path.resolve(inputPath))
    : parsed.base;
  const relativeParsed = path.parse(relativeInput);

  return path.join(outputPath, relativeParsed.dir, `${relativeParsed.name}.png`);
}
