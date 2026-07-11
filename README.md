# Background Removal Tool

This project provides an on-device CLI for removing the background from portrait photos. It detects the person automatically, keeps the subject pixels, and writes out a PNG with a transparent background.

## Approach

- `sharp` decodes common raster formats locally and writes the final transparent PNG.
- `@imgly/background-removal-node` performs local person/background segmentation without sending the image to a remote API.
- The generated alpha matte is lightly blurred before export so hair and clothing edges look less cut out against a new background.
- Batch mode processes images one by one and records failures without aborting the whole run.

## Install

```bash
npm install
```

## Usage

Single image:

```bash
node ./src/cli.js image --input ./photos/person.jpg
```

Write to a specific file:

```bash
node ./src/cli.js image --input ./photos/person.jpg --output ./exports/person.png
```

Batch a directory:

```bash
node ./src/cli.js batch --input ./photos --output ./exports --recursive
```

## Notes

- Output is always PNG because transparency is required.
- The current segmentation backend is tuned for person photos. Non-person images can fail or produce weak masks.
- If one file fails in batch mode, processing continues and the CLI reports the failed paths at the end.

## Tests

```bash
npm test
```
