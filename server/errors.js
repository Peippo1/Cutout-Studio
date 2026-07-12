export class HttpError extends Error {
  constructor(statusCode, message, options = {}) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.reasonCode = options.reasonCode || "unknown_error";
  }
}

export function isHttpError(error) {
  return error instanceof HttpError;
}
