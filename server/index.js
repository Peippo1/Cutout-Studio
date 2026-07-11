import { createServer } from "node:http";
import { createApp } from "./app.js";
import { config, validateServerConfig } from "./config.js";

validateServerConfig(config);
const app = await createApp();
const server = createServer(app);

server.requestTimeout = 2 * 60 * 1000;

server.listen(config.port, config.host, () => {
  console.log(`Cutout Studio listening on http://${config.host}:${config.port}`);
});
