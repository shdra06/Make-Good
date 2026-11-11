// One error type the HTTP layer understands. Anything else is an unexpected
// failure and is reported to the caller as a plain 500 without details.

export class AppError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly details: unknown;

  constructor(code: string, httpStatus: number, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super("VALIDATION_FAILED", 422, message, details);
    this.name = "ValidationError";
  }
}

export class UnauthenticatedError extends AppError {
  constructor(message = "Sign in to continue.") {
    super("UNAUTHENTICATED", 401, message);
    this.name = "UnauthenticatedError";
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Your role does not allow this.") {
    super("FORBIDDEN", 403, message);
    this.name = "ForbiddenError";
  }
}

export class NotFoundError extends AppError {
  constructor(what = "Record") {
    super("NOT_FOUND", 404, `${what} not found.`);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends AppError {
  constructor(code: string, message: string, details?: unknown) {
    super(code, 409, message, details);
    this.name = "ConflictError";
  }
}

export class RateLimitedError extends AppError {
  constructor(retryAfterSeconds: number) {
    super("RATE_LIMITED", 429, "Too many requests. Please wait and try again.", { retryAfterSeconds });
    this.name = "RateLimitedError";
  }
}

/** A dependency we need is not configured (for example no PayPal connection). */
export class NotConfiguredError extends AppError {
  constructor(code: string, message: string) {
    super(code, 503, message);
    this.name = "NotConfiguredError";
  }
}
