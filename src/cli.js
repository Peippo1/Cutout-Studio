#!/usr/bin/env node

import path from "node:path";
import { stat } from "node:fs/promises";
import { createBackgroundRemover, loadSegmenter } from "./background-remover.js";
import { toOutputPngPath } from "./file-utils.js";

function printUsage() {
  console.log(`Usage:
  remove-background image --input <file> [--output <file-or-dir>] [--edge-blur <number>]
  remove-background batch --input <directory> [--output <directory>] [--recursive] [--edge-blur <number>]`);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { command };

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];

    if (token === "--recursive") {
      options.recursive = true;
      continue;
    }

    if (!token.startsWith("--")) {
      throw new Error(`Unexpected argument: ${token}`);
    }

    const value = rest[index + 1];

    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${token}`);
    }

    options[token.slice(2)] = value;
    index += 1;
  }

  return options;
}

async function ensurePathExists(targetPath, expectedType) {
  const targetStat = await stat(targetPath);

  if (expectedType === "file" && !targetStat.isFile()) {
    throw new Error(`${targetPath} is not a file.`);
  }

  if (expectedType === "directory" && !targetStat.isDirectory()) {
    throw new Error(`${targetPath} is not a directory.`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (!options.command || options.command === "--help" || options.command === "-h") {
    printUsage();
    return;
  }

  const segmentPerson = await loadSegmenter();
  const remover = createBackgroundRemover({ segmentPerson });
  const edgeBlur = options["edge-blur"] ? Number(options["edge-blur"]) : undefined;

  if (Number.isNaN(edgeBlur)) {
    throw new Error("--edge-blur must be a number.");
  }

  if (options.command === "image") {
    if (!options.input) {
      throw new Error("--input is required for image mode.");
    }

    const inputPath = path.resolve(options.input);
    await ensurePathExists(inputPath, "file");

    const outputPath = toOutputPngPath(inputPath, options.output);
    const result = await remover.removeBackgroundFromImage(inputPath, outputPath, { edgeBlur });

    console.log(`Wrote ${result.outputPath} (${result.width}x${result.height})`);
    return;
  }

  if (options.command === "batch") {
    if (!options.input) {
      throw new Error("--input is required for batch mode.");
    }

    const inputDir = path.resolve(options.input);
    const outputDir = options.output ? path.resolve(options.output) : path.join(inputDir, "output");
    await ensurePathExists(inputDir, "directory");

    const summary = await remover.removeBackgroundFromDirectory(inputDir, outputDir, {
      recursive: Boolean(options.recursive),
      edgeBlur,
    });

    console.log(`Processed ${summary.processed.length}/${summary.total} images.`);

    if (summary.failures.length > 0) {
      console.error("Failures:");

      for (const failure of summary.failures) {
        console.error(`- ${failure.inputPath}: ${failure.error}`);
      }

      process.exitCode = 1;
    }

    return;
  }

  throw new Error(`Unknown command: ${options.command}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  printUsage();
  process.exitCode = 1;
});
