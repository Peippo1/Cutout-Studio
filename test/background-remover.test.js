import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import sharp from "sharp";
import { createBackgroundRemover } from "../src/background-remover.js";

async function createFixtureImage(filePath, color = { r: 255, g: 0, b: 0 }) {
  const buffer = await sharp({
    create: {
      width: 4,
      height: 4,
      channels: 3,
      background: color,
    },
  })
    .png()
    .toBuffer();

  await writeFile(filePath, buffer);
}

test("removeBackgroundFromDirectory continues when one image fails", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "bg-remove-"));
  const inputDir = path.join(tempDir, "input");
  const outputDir = path.join(tempDir, "output");

  await mkdir(inputDir, { recursive: true });
  await createFixtureImage(path.join(inputDir, "good.png"), { r: 255, g: 0, b: 0 });
  await createFixtureImage(path.join(inputDir, "bad.png"), { r: 0, g: 0, b: 255 });
  const badBuffer = await readFile(path.join(inputDir, "bad.png"));

  const remover = createBackgroundRemover({
    async segmentPerson(inputBuffer) {
      const metadata = await sharp(inputBuffer).metadata();

      if (metadata.width === 4) {
        const png = await sharp({
          create: {
            width: 4,
            height: 4,
            channels: 4,
            background: { r: 255, g: 0, b: 0, alpha: 1 },
          },
        })
          .png()
          .toBuffer();

        if (inputBuffer.equals(badBuffer)) {
          throw new Error("Synthetic segmentation failure");
        }

        return png;
      }

      throw new Error("Unexpected fixture size");
    },
  });

  const summary = await remover.removeBackgroundFromDirectory(inputDir, outputDir);

  assert.equal(summary.total, 2);
  assert.equal(summary.processed.length, 1);
  assert.equal(summary.failures.length, 1);
  assert.match(summary.failures[0].error, /Synthetic segmentation failure/);
});

test("removeBackgroundFromImage writes an alpha PNG", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "bg-single-"));
  const inputPath = path.join(tempDir, "person.png");
  const outputPath = path.join(tempDir, "person.transparent.png");

  await createFixtureImage(inputPath, { r: 0, g: 255, b: 0 });

  const mask = await sharp({
    create: {
      width: 4,
      height: 4,
      channels: 4,
      background: { r: 0, g: 255, b: 0, alpha: 1 },
    },
  })
    .png()
    .toBuffer();

  const remover = createBackgroundRemover({
    async segmentPerson() {
      return mask;
    },
  });

  await remover.removeBackgroundFromImage(inputPath, outputPath);

  const metadata = await sharp(outputPath).metadata();
  assert.equal(metadata.format, "png");
  assert.equal(metadata.hasAlpha, true);
});
