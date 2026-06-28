export class DomainError extends Error {
  constructor(
    message: string,
    public readonly code: string = "INTERNAL_ERROR"
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export class NotFoundError extends DomainError {
  constructor(message: string) {
    super(message, "NOT_FOUND");
    this.name = "NotFoundError";
  }
}

export class ValidationError extends DomainError {
  constructor(message: string) {
    super(message, "VALIDATION_ERROR");
    this.name = "ValidationError";
  }
}

export class UpstreamError extends DomainError {
  constructor(message: string) {
    super(message, "UPSTREAM_ERROR");
    this.name = "UpstreamError";
  }
}
