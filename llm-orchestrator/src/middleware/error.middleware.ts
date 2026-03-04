// =============================================================================
// src/middleware/error.middleware.ts
// Global Express error handling middleware.
// Catches all unhandled errors and returns structured IErrorResponse.
// Follows the Express error-handling middleware pattern (4 parameters).
// =============================================================================

import { Request, Response, NextFunction } from "express";
import { IErrorResponse, ErrorCode } from "../interfaces";
import { AppError } from "../utils/helpers";

/**
 * Global error handling middleware for Express.
 *
 * How Express error handling works:
 * - Normal middleware: (req, res, next) — 3 params
 * - Error middleware: (err, req, res, next) — 4 params
 * - Express detects the 4-param signature and routes errors here
 * - When ANY middleware/route calls next(error) or throws, this catches it
 *
 * Why centralized error handling?
 * - DRY: Error response formatting in ONE place, not scattered across routes
 * - Consistency: Every error response has the same shape (IErrorResponse)
 * - Safety: No unhandled errors leak stack traces to the client
 * - Logging: All errors are logged in one place
 *
 * IMPORTANT: This middleware must be registered LAST in the Express app
 * (after all routes and other middleware).
 */
export function errorMiddleware(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  // Log the error for server-side debugging
  console.error(`[ERROR] ${err.name}: ${err.message}`);
  if (err.stack && process.env["LOG_LEVEL"] === "debug") {
    console.error(err.stack);
  }

  // If it's one of our custom AppError subclasses, use its data
  if (err instanceof AppError) {
    const errorResponse: IErrorResponse = {
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
      },
    };

    res.status(err.statusCode).json(errorResponse);
    return;
  }

  // For unexpected errors (not our AppError), return a generic 500
  // NEVER expose internal error details to the client in production
  const errorResponse: IErrorResponse = {
    error: {
      code: ErrorCode.INTERNAL_ERROR,
      message: "An unexpected internal error occurred.",
      details:
        process.env["NODE_ENV"] === "development" ? err.message : undefined,
    },
  };

  res.status(500).json(errorResponse);
}

/**
 * Middleware to handle 404 (route not found).
 * Registered after all routes — if no route matched, this fires.
 *
 * @param req - The Express request
 * @param res - The Express response
 */
export function notFoundMiddleware(
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const errorResponse: IErrorResponse = {
    error: {
      code: ErrorCode.VALIDATION_ERROR,
      message: `Route not found: ${req.method} ${req.path}`,
      details: "Available endpoints: POST /api/orchestrate, POST /api/orchestrate/stream, GET /api/health",
    },
  };

  res.status(404).json(errorResponse);
}
