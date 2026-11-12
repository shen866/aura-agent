export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class ConfigValidationError extends Error {
  constructor(
    message: string,
    readonly errors: string[],
    readonly warnings: string[]
  ) {
    super(message);
    this.name = "ConfigValidationError";
  }
}
