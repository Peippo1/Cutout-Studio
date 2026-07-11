import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { isImageFile, toOutputPngPath } from "../src/file-utils.js";

test("isImageFile detects common raster formats", () => {
  assert.equal(isImageFile("/tmp/person.JPG"), true);
  assert.equal(isImageFile("/tmp/person.png"), true);
  assert.equal(isImageFile("/tmp/person.txt"), false);
});

test("toOutputPngPath creates a sibling transparent file by default", () => {
  const outputPath = toOutputPngPath("/photos/input/portrait.jpg");
  assert.equal(outputPath, path.resolve("/photos/input/portrait.transparent.png"));
});

test("toOutputPngPath preserves relative structure for batch output directories", () => {
  const outputPath = toOutputPngPath(
    "/photos/input/nested/portrait.jpg",
    "/photos/output",
    "/photos/input",
  );

  assert.equal(outputPath, path.resolve("/photos/output/nested/portrait.png"));
});
