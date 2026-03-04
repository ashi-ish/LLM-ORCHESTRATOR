// =============================================================================
// src/utils/helpers.ts
// Utility functions and custom error classes.
// Pure helpers with no side effects and no external dependencies.
// Follows SRP — small, focused, reusable functions.
// =============================================================================

import { ErrorCode } from "../interfaces";

// -----------------------------------------------------------------------------
// Custom Error Classes
// -----------------------------------------------------------------------------

/**
 * Base class for all application errors.
 *
 * Why custom error classes?
 * - JavaScript's built-in Error only has `message` and `stack`
 * - We need: error code (for programmatic handling), HTTP status (for API responses),
 *   and details (for debugging)
 * - Custom errors let us do: `if (error instanceof LLMError)` — type-safe error handling
 * - They carry structured data that the error middleware can use to build IErrorResponse
 *
 * Why extend Error (not create a plain object)?
 * - Stack traces work correctly (shows where the error was thrown)
 * - `instanceof` checks work
 * - Works with try/catch as expected
 * - Libraries and frameworks recognize it as an Error
 */
export class AppError extends Error {
  /** Machine-readable error code from our ErrorCode enum */
  readonly code: ErrorCode;
  /** HTTP status code to return in the API response */
  readonly statusCode: number;
  /** Additional details for debugging (not always shown to users) */
  readonly details?: string;

  constructor(
    message: string,
    code: ErrorCode,
    statusCode: number,
    details?: string,
  ) {
    super(message);

    // This is required in TypeScript when extending built-in classes.
    // Without it, `instanceof AppError` may not work correctly.
    // See: https://github.com/microsoft/TypeScript/wiki/Breaking-Changes#extending-built-ins-like-error-array-and-map-may-no-longer-work
    Object.setPrototypeOf(this, new.target.prototype);

    this.name = this.constructor.name; // "AppError", "LLMError", etc.
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

/**
 * Error thrown when configuration is invalid or missing.
 * HTTP 500 — this is a server-side issue, not the client's fault.
 */
export class ConfigError extends AppError {
  constructor(message: string, details?: string) {
    super(message, ErrorCode.CONFIG_ERROR, 500, details);
  }
}

/**
 * Error thrown when the LLM API call fails.
 * HTTP 502 — Bad Gateway (our upstream dependency failed).
 */
export class LLMError extends AppError {
  constructor(message: string, details?: string) {
    super(message, ErrorCode.LLM_ERROR, 502, details);
  }
}

/**
 * Error thrown when the LLM rate limit is hit.
 * HTTP 429 — Too Many Requests (pass through the rate limit status).
 */
export class LLMRateLimitError extends AppError {
  constructor(
    message: string = "LLM rate limit exceeded. Please try again later.",
  ) {
    super(message, ErrorCode.LLM_RATE_LIMIT, 429);
  }
}

/**
 * Error thrown when LLM authentication fails.
 * HTTP 500 — server config issue, not the client's fault.
 */
export class LLMAuthError extends AppError {
  constructor(
    message: string = "LLM authentication failed. Check API key configuration.",
  ) {
    super(message, ErrorCode.LLM_AUTH_ERROR, 500);
  }
}

/**
 * Error thrown when a search API call fails.
 * HTTP 502 — Bad Gateway.
 */
export class SearchError extends AppError {
  constructor(message: string, details?: string) {
    super(message, ErrorCode.SEARCH_ERROR, 502, details);
  }
}

/**
 * Error thrown when search returns no results.
 * NOT a server error — HTTP 200 with a note in the response.
 * This is informational, not exceptional. We use the class
 * for type-safe checking but don't necessarily throw it.
 */
export class SearchNoResultsError extends AppError {
  constructor(query: string) {
    super(
      `No search results found for: "${query}"`,
      ErrorCode.SEARCH_NO_RESULTS,
      200, // Not an HTTP error — search worked, just found nothing
    );
  }
}

/**
 * Error thrown when the orchestration process fails.
 * HTTP 500 — Internal Server Error.
 */
export class OrchestrationError extends AppError {
  constructor(message: string, details?: string) {
    super(message, ErrorCode.ORCHESTRATION_ERROR, 500, details);
  }
}

/**
 * Error thrown when request validation fails.
 * HTTP 400 — Bad Request (the client sent invalid data).
 */
export class ValidationError extends AppError {
  constructor(message: string, details?: string) {
    super(message, ErrorCode.VALIDATION_ERROR, 400, details);
  }
}

// -----------------------------------------------------------------------------
// Validation Helpers
// -----------------------------------------------------------------------------

/**
 * Validate the user's query from the request body.
 *
 * Checks:
 * 1. query exists
 * 2. query is a string
 * 3. query is not empty/whitespace
 * 4. query is not too long (prevent abuse)
 *
 * Why validate at the edge?
 * - Invalid data should be rejected BEFORE it enters the system
 * - The orchestrator, LLM client, and search client should never receive bad input
 * - This follows the "Fail Fast" principle
 *
 * @param body - The parsed request body
 * @returns The cleaned query string
 * @throws ValidationError if the query is invalid
 */
export function validateQuery(body: unknown): string {
  if (!body || typeof body !== "object") {
    throw new ValidationError(
      "Request body must be a JSON object with a 'query' field.",
      'Expected: { "query": "your question here" }',
    );
  }

  const { query } = body as { query?: unknown };

  if (query === undefined || query === null) {
    throw new ValidationError(
      "Missing required field: 'query'.",
      "The request body must include a 'query' field with your question.",
    );
  }

  if (typeof query !== "string") {
    throw new ValidationError(
      "Field 'query' must be a string.",
      `Received type: ${typeof query}`,
    );
  }

  const trimmed = query.trim();

  if (trimmed.length === 0) {
    throw new ValidationError(
      "Field 'query' cannot be empty.",
      "Please provide a question or topic to research.",
    );
  }

  const MAX_QUERY_LENGTH = 2000;
  if (trimmed.length > MAX_QUERY_LENGTH) {
    throw new ValidationError(
      `Field 'query' is too long (${trimmed.length} characters).`,
      `Maximum allowed length is ${MAX_QUERY_LENGTH} characters.`,
    );
  }

  return trimmed;
}

// -----------------------------------------------------------------------------
// General Utility Functions
// -----------------------------------------------------------------------------

/**
 * Safely extract an error message from an unknown caught value.
 *
 * Why?
 * In TypeScript with strict mode, catch variables are typed as `unknown`:
 *   try { ... } catch (error) { // error is `unknown` }
 * You can't do `error.message` without narrowing the type first.
 * This helper does that narrowing safely.
 *
 * @param error - The caught value (could be Error, string, or anything)
 * @returns A string error message
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}
