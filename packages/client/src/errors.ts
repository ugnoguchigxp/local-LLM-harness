export class LarmApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly responseBody?: unknown,
  ) {
    super(message);
    this.name = "LarmApiError";
  }
}

export class LarmClientConfigurationError extends Error {
  constructor(readonly code: "api_token_missing", message: string) {
    super(message);
    this.name = "LarmClientConfigurationError";
  }
}

export class LarmEpochChangedError extends Error {
  constructor(readonly previous: string, readonly current: string) {
    super(`LARM boot epoch changed from ${previous} to ${current}; start a new request lifecycle`);
    this.name = "LarmEpochChangedError";
  }
}

export class LarmStreamProtocolError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "LarmStreamProtocolError";
  }
}
