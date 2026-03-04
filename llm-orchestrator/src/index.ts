// =============================================================================
// src/index.ts
// Application entry point — creates Express app, wires dependencies, starts server.
// This is the "composition root" — the ONLY place where concrete implementations
// are instantiated and wired together.
// =============================================================================

import express from "express";
import { config } from "./config";
import { AnthropicLLMClient } from "./clients/llm.client";
import { TavilySearchClient } from "./clients/search.client";
import { OrchestratorService } from "./services/orchestrator.service";
import { createOrchestratorRouter } from "./routes/orchestrator.route";
import {
  errorMiddleware,
  notFoundMiddleware,
} from "./middleware/error.middleware";

/**
 * Bootstrap and start the application.
 *
 * Why wrap in a function?
 * - Allows async/await (top-level await requires ESM, we're using CommonJS)
 * - Provides a clear, single entry point
 * - Errors during startup are caught and logged cleanly
 *
 * This function is the "Composition Root" — a pattern from dependency injection.
 * It's the ONE place where we:
 * 1. Create concrete class instances (AnthropicLLMClient, TavilySearchClient)
 * 2. Wire them together (pass to OrchestratorService)
 * 3. Mount them into the Express app
 *
 * No other file in the project creates these instances. This ensures:
 * - All dependencies are configured in one place
 * - The dependency graph is visible at a glance
 * - Swapping implementations means changing only this file
 */
async function bootstrap(): Promise<void> {
  // ---------------------------------------------------------------------------
  // 1. Create concrete implementations (Composition Root)
  // ---------------------------------------------------------------------------

  console.log("Initializing services...");

  // Create the LLM client (Anthropic Claude)
  const llmClient = new AnthropicLLMClient();

  // Create the search client (Tavily)
  const searchClient = new TavilySearchClient();

  // Create the orchestrator, injecting its dependencies
  const orchestratorService = new OrchestratorService(llmClient, searchClient);

  console.log("Services initialized successfully.");

  // ---------------------------------------------------------------------------
  // 2. Create Express application
  // ---------------------------------------------------------------------------

  const app = express();

  // ---------------------------------------------------------------------------
  // 3. Register middleware (order matters!)
  // ---------------------------------------------------------------------------

  // Parse JSON request bodies
  // This MUST come before routes — otherwise req.body is undefined
  app.use(express.json({ limit: "1mb" }));

  // Simple request logging middleware
  // Logs method, path, and response time for every request
  app.use((req, res, next) => {
    const start = Date.now();
    res.on("finish", () => {
      const duration = Date.now() - start;
      console.log(
        `[${new Date().toISOString()}] ${req.method} ${req.path} → ${res.statusCode} (${duration}ms)`,
      );
    });
    next();
  });

  // ---------------------------------------------------------------------------
  // 4. Register routes
  // ---------------------------------------------------------------------------

  // Mount the orchestrator routes under /api
  app.use("/api", createOrchestratorRouter(orchestratorService));

  // ---------------------------------------------------------------------------
  // 5. Register error handling middleware (MUST be after routes)
  // ---------------------------------------------------------------------------

  // 404 handler — catches requests to undefined routes
  app.use(notFoundMiddleware);

  // Global error handler — catches all errors from routes/middleware
  // Express requires this to have 4 params to be recognized as error middleware
  app.use(errorMiddleware);

  // ---------------------------------------------------------------------------
  // 6. Start the server
  // ---------------------------------------------------------------------------

  const server = app.listen(config.port, () => {
    console.log("=".repeat(60));
    console.log(`  LLM Orchestrator is running!`);
    console.log(`  URL: http://localhost:${config.port}`);
    console.log(`  Endpoints:`);
    console.log(`    POST http://localhost:${config.port}/api/orchestrate`);
    console.log(`    POST http://localhost:${config.port}/api/orchestrate/stream`);
    console.log(`    GET  http://localhost:${config.port}/api/health`);
    console.log(`  LLM: Anthropic (${config.anthropicModel})`);
    console.log(`  Search: Tavily`);
    console.log("=".repeat(60));
  });

  // ---------------------------------------------------------------------------
  // 7. Graceful shutdown
  // ---------------------------------------------------------------------------

  /**
   * On SIGTERM/SIGINT, stop accepting new connections and let in-flight
   * requests finish before exiting. This prevents dropped requests during
   * deploys or container restarts.
   */
  const shutdown = (signal: string) => {
    console.log(`\n${signal} received. Shutting down gracefully...`);
    server.close(() => {
      console.log("All connections closed. Exiting.");
      process.exit(0);
    });

    // Force exit if graceful shutdown takes too long (10 seconds)
    setTimeout(() => {
      console.error("Graceful shutdown timed out. Forcing exit.");
      process.exit(1);
    }, 10_000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

// ---------------------------------------------------------------------------
// Start the application
// ---------------------------------------------------------------------------

bootstrap().catch((error) => {
  console.error("Fatal error during startup:", error);
  process.exit(1);
});
