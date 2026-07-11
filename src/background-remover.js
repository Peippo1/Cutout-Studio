import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import sharp from "sharp";
import { collectImageFiles, toOutputPngPath } from "./file-utils.js";

const DEFAULT_EDGE_BLUR = 0.8;

function combineRgbAndAlpha(rgbBuffer, alphaBuffer) {
  if (rgbBuffer.length / 3 !== alphaBuffer.length) {
    throw new Error("RGB and alpha channel sizes do not match.");
  }

  const pixelCount = alphaBuffer.length;
  const rgbaBuffer = Buffer.allocUnsafe(pixelCount * 4);

  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
    const rgbOffset = pixelIndex * 3;
    const rgbaOffset = pixelIndex * 4;

    rgbaBuffer[rgbaOffset] = rgbBuffer[rgbOffset];
    rgbaBuffer[rgbaOffset + 1] = rgbBuffer[rgbOffset + 1];
    rgbaBuffer[rgbaOffset + 2] = rgbBuffer[rgbOffset + 2];
    rgbaBuffer[rgbaOffset + 3] = alphaBuffer[pixelIndex];
  }

  return rgbaBuffer;
}

async function toBuffer(value) {
  if (Buffer.isBuffer(value)) {
    return value;
  }

  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }

  if (value instanceof ArrayBuffer) {
    return Buffer.from(value);
  }

  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return Buffer.from(await value.arrayBuffer());
  }

  throw new TypeError("Unsupported segmentation output type.");
}

export async function loadSegmenter() {
  const { removeBackground } = await import("@imgly/background-removal-node");

  return async function segmentPerson(inputBuffer) {
    const result = await removeBackground(inputBuffer, {
      output: {
        format: "image/png",
      },
    });

    return toBuffer(result);
  };
}

export function createBackgroundRemover({ segmentPerson }) {
  if (typeof segmentPerson !== "function") {
    throw new TypeError("segmentPerson must be a function.");
  }

  async function removeBackgroundFromImage(inputPath, outputPath, options = {}) {
    const edgeBlur = options.edgeBlur ?? DEFAULT_EDGE_BLUR;
    const inputBuffer = await readFile(inputPath);

    // Sharp normalizes orientation and decodes the source image locally.
    const original = sharp(inputBuffer, { failOn: "none" }).rotate();
    const originalMetadata = await original.metadata();

    if (!originalMetadata.width || !originalMetadata.height) {
      throw new Error(`Could not determine dimensions for ${inputPath}.`);
    }

    const segmentedBuffer = await segmentPerson(inputBuffer);
    const segmented = sharp(segmentedBuffer, { failOn: "none" }).ensureAlpha();
    const segmentedMetadata = await segmented.metadata();

    if (
      segmentedMetadata.width !== originalMetadata.width ||
      segmentedMetadata.height !== originalMetadata.height
    ) {
      throw new Error(
        `Segmentation output dimensions for ${inputPath} do not match the source image.`,
      );
    }

    // Feather the matte slightly to avoid cut-out looking edges on hair and clothing.
    const softenedAlpha = await segmented
      .extractChannel("alpha")
      .blur(edgeBlur)
      .raw()
      .toBuffer();

    const rgb = await original.removeAlpha().raw().toBuffer();
    const rgba = combineRgbAndAlpha(rgb, softenedAlpha);
    const outputBuffer = await sharp(rgba, {
      raw: {
        width: originalMetadata.width,
        height: originalMetadata.height,
        channels: 4,
      },
    })
      .png()
      .toBuffer();

    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, outputBuffer);

    return {
      inputPath,
      outputPath,
      width: originalMetadata.width,
      height: originalMetadata.height,
    };
  }

  async function removeBackgroundFromDirectory(inputDir, outputDir, options = {}) {
    const normalizedOutputDir = outputDir ? path.resolve(outputDir) : null;
    const files = (await collectImageFiles(inputDir, { recursive: options.recursive })).filter(
      (inputPath) =>
        !normalizedOutputDir ||
        path.resolve(inputPath) !== normalizedOutputDir &&
          !path.resolve(inputPath).startsWith(`${normalizedOutputDir}${path.sep}`),
    );
    const results = [];
    const failures = [];

    for (const inputPath of files) {
      const outputPath = toOutputPngPath(inputPath, outputDir, inputDir);

      try {
        const result = await removeBackgroundFromImage(inputPath, outputPath, options);
        results.push(result);
      } catch (error) {
        failures.push({
          inputPath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      processed: results,
      failures,
      total: files.length,
    };
  }

  return {
    removeBackgroundFromImage,
    removeBackgroundFromDirectory,
  };
}
