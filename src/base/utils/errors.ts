// ─── Custom Error Classes ───

export class LLMError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'LLMError';
  }
}

export class AdapterError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'AdapterError';
  }
}

export class ValidationError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class StateError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'StateError';
  }
}

export class StateFenceError extends StateError {
  constructor(message: string, public readonly cause?: unknown) {
    super(message, cause);
    this.name = 'StateFenceError';
  }
}
