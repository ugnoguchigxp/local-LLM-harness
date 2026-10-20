export class DecisionError extends Error {
  constructor(readonly code: string, readonly status: 400 | 404 | 409 | 413 | 429 | 503 = 400) { super(code); }
}
