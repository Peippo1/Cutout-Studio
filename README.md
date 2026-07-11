# Background Removal Tool

This project now ships two surfaces:

- a CLI for single-image and batch background removal
- a lightweight React + TypeScript frontend with an Express API, usage limits, login-backed access control, and optional Turnstile verification

## What it does

- `sharp` decodes common raster formats and writes the final transparent PNG.
- `@imgly/background-removal-node` performs local person/background segmentation inside the running Node process.
- The alpha matte is lightly blurred before export so hair and clothing edges look less cut out.
- The web API enforces file-size limits, image-dimension limits, MIME validation, and per-IP rate limits.
- GitHub OAuth can require a verified email before a session is allowed to process images.
- The current acceptable-use policy version must be accepted in-session before uploads are processed.
- Cloudflare Turnstile can be enabled as an additional verification layer before the server processes the upload.

## Install

```bash
npm install
```

## Web app

Run the API and TypeScript frontend together:

```bash
npm run dev
```

The frontend runs on `http://127.0.0.1:5173` and proxies API requests to `http://127.0.0.1:3001`.

Build the client:

```bash
npm run build
```

Serve the built app with the API:

```bash
npm run start
```

### Environment

Copy [.env.example](/Users/tim/Documents/Codex/2026-07-11/building-a-background-removal-tool-you/.env.example:1) into `.env` and adjust as needed.

Important settings:

- `HOST`: host interface for the API server, default `127.0.0.1`
- `MAX_UPLOAD_MB`: maximum upload size accepted by the API
- `MAX_IMAGE_PIXELS`: pixel ceiling for decoded images
- `RATE_LIMIT_WINDOW_MINUTES`: rate-limit time window
- `RATE_LIMIT_MAX_REQUESTS`: allowed requests per IP during that window
- `SESSION_SECRET`: cookie/session signing secret
- `SESSION_TTL_DAYS`: how long a signed-in session can persist
- `ACCEPTABLE_USE_VERSION`: policy version users must accept before processing
- `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_CALLBACK_URL`: when all are set with `SESSION_SECRET`, sign-in is enforced before image processing
- `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY`: when both are set, Turnstile verification is also required

## Access model

For a public free deployment, the intended flow is:

1. User signs in with GitHub.
2. The callback only accepts accounts with a verified email.
3. The user accepts the current usage-policy version in-session.
4. The server enforces rate limits, payload limits, MIME checks, image-size checks, and optional Turnstile before processing.

This is a practical anti-abuse baseline, not a full moderation pipeline. If you want stronger controls against illegal or exploitative uploads, the next layer should be content moderation and operator review, which is not implemented yet.

## CLI usage

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
- The segmentation backend is tuned for person photos. Non-person images can fail or produce weak masks.
- The CLI processes images locally on the machine running the command.
- The web surface processes uploads on the server hosting the app, so its privacy model is different from the standalone CLI.
- The current web session store uses the default in-memory store. That is acceptable for local use or a small single-instance deployment, but a production multi-instance deployment should move sessions into a shared store.

## Tests

```bash
npm test
```
