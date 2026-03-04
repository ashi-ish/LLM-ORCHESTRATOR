// =============================================================================
// src/routes/orchestrator.route.ts
// Express route definitions for the orchestrator API.
// Follows SRP — routes only handle HTTP concerns (parsing, validation, response).
// Business logic is delegated to services.
// =============================================================================

import { Router, Request, Response, NextFunction } from "express";
import { v4 as uuidv4 } from "uuid";
import { OrchestratorService } from "../services/orchestrator.service";
import { IUserRequest } from "../interfaces";
import { validateQuery } from "../utils/helpers";

/**
 * Create the orchestrator router.
 *
 * Why a factory function instead of a plain Router export?
 * - Allows dependency injection: the OrchestratorService is passed in
 * - Makes testing easy: pass a mock service
 * - The route file doesn't create or know about concrete implementations
 * - Follows DIP — depends on the service interface, not internals
 *
 * @param orchestratorService - The wired orchestrator service instance
 * @returns Express Router with all orchestrator routes
 */
export function createOrchestratorRouter(
  orchestratorService: OrchestratorService,
): Router {
  const router = Router();

  // ---------------------------------------------------------------------------
  // POST /api/orchestrate
  // Main endpoint — accepts a query and returns a grounded, traced response
  // ---------------------------------------------------------------------------

  /**
   * POST /api/orchestrate
   *
   * Request body: { "query": "your question here" }
   *
   * Response: IOrchestratorResponse (answer, sources, trace, metadata)
   *
   * Flow:
   * 1. Validate the query
   * 2. Generate a unique request ID
   * 3. Log the incoming request
   * 4. Call the orchestrator service
   * 5. Return the structured response
   *
   * Errors are caught and passed to the error middleware via next(error).
   */
  router.post(
    "/orchestrate",
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        // Step 1: Validate input
        const query = validateQuery(req.body);

        // Step 2: Generate unique request ID for traceability
        const requestId = uuidv4();

        // Step 3: Log the request (lightweight — just the essentials)
        console.log(
          `[${new Date().toISOString()}] Request ${requestId}: "${query.slice(0, 100)}${query.length > 100 ? "..." : ""}"`,
        );

        // Step 4: Build the user request object
        const userRequest: IUserRequest = {
          query,
          requestId,
        };

        // Step 5: Process through the orchestrator
        const startTime = Date.now();
        const response = await orchestratorService.processRequest(userRequest);
        const durationMs = Date.now() - startTime;

        // Step 6: Log completion
        console.log(
          `[${new Date().toISOString()}] Request ${requestId} completed in ${durationMs}ms ` +
            `(${response.sources.length} sources, confidence: ${response.answer.confidence})`,
        );

        // Step 7: Send response
        res.status(200).json(response);
      } catch (error) {
        // Pass to error middleware — NEVER handle errors in routes
        // The error middleware formats and sends the error response
        next(error);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // POST /api/orchestrate/stream
  // Streaming endpoint — returns Server-Sent Events as the answer generates
  // ---------------------------------------------------------------------------

  /**
   * POST /api/orchestrate/stream
   *
   * Same request body as /orchestrate, but returns SSE stream instead of JSON.
   * Client receives events in real-time: status, sources, answer chunks, metadata.
   *
   * Why SSE over WebSockets?
   * - Simpler — unidirectional (server → client), no handshake protocol
   * - Built into browsers via EventSource API
   * - Works over standard HTTP — no firewall issues
   * - Perfect for this use case (server streams, client listens)
   */
  router.post(
    "/orchestrate/stream",
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const query = validateQuery(req.body);
        const requestId = uuidv4();

        console.log(
          `[${new Date().toISOString()}] Stream ${requestId}: "${query.slice(0, 100)}${query.length > 100 ? "..." : ""}"`,
        );

        const userRequest: IUserRequest = { query, requestId };

        // Set SSE headers
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Request-Id", requestId);
        res.flushHeaders();

        // Stream events to the client
        for await (const event of orchestratorService.processRequestStream(
          userRequest,
        )) {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        }

        res.end();
      } catch (error) {
        next(error);
      }
    },
  );
  // ---------------------------------------------------------------------------
  // GET /api/health
  // Health check endpoint — used to verify the server is running
  // ---------------------------------------------------------------------------

  /**
   * GET /api/health
   *
   * Returns: { status: "ok", timestamp, uptime }
   *
   * Why a health endpoint?
   * - Load balancers use it to check if the server is alive
   * - Monitoring tools ping it to detect outages
   * - Quick way to verify the deployment is working
   * - Industry standard practice for any HTTP service
   */
  router.get("/health", (_req: Request, res: Response): void => {
    res.status(200).json({
      status: "ok",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    });
  });

  return router;
}
