import assert from "node:assert/strict";
import { existsSync } from "node:fs";

assert.equal(existsSync("dist/server/index.js"), true, "Run npm run build before verify:sites.");

const runtime = await import(`../dist/server/index.js?cacheBust=${Date.now()}`);
const response = await runtime.fetch(new Request("https://cutout.example/api/config"));
const payload = await response.json();

assert.equal(response.status, 200);
assert.equal(payload.processingEnabled, false);
assert.equal(payload.deploymentMode, "sites-shell");
assert.equal(response.headers.get("x-content-type-options"), "nosniff");
assert.equal(response.headers.get("referrer-policy"), "no-referrer");
assert.match(response.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);

console.log("Sites runtime verified.");
