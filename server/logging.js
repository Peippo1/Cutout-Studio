import crypto from "node:crypto";

export function digestValue(value) {
  if (!value) {
    return null;
  }

  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 24);
}

export function createLogger() {
  return {
    info(event, payload = {}) {
      console.log(
        JSON.stringify({
          level: "info",
          event,
          timestamp: new Date().toISOString(),
          ...payload,
        }),
      );
    },
    error(event, payload = {}) {
      console.error(
        JSON.stringify({
          level: "error",
          event,
          timestamp: new Date().toISOString(),
          ...payload,
        }),
      );
    },
  };
}
