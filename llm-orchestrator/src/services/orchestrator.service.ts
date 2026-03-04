// =============================================================================
// src/services/orchestrator.service.ts
// The CORE of the application — the orchestration engine.
// Takes a user query → plans steps → executes them → produces grounded output.
// Follows SRP — coordinates, doesn't do the actual work itself.
// Follows OCP — new step types can be added without modifying the core loop.
// =============================================================================
import {
  ILLMClient,
  ISearchClient,
  IOrchestratorStep,
  IStepResult,
  IOrchestratorResponse,
  IUserRequest,
  ISource,
  IResponseMetadata,
  IStreamEvent,
  ISnippet,
  StepStatus,
  RequestTimeoutError,
} from "../interfaces";
import { config } from "../config";
import { RetrievalService } from "./retrieval.service";
import { TraceService } from "./trace.service";

/**
 * OrchestratorService — the brain of the application.
 *
 * Orchestration Flow:
 * ┌─────────────────────────────────────────────────────────────┐
 * │ 1. RECEIVE user query                                       │
 * │ 2. PLAN — create a default search plan (no LLM call)        │    
 * │ 3. EXECUTE — run steps (parallel where independent)         │
 * │    ├── Search steps → SearchClient → RetrievalService       │
 * │    ├── Analyze steps → LLM analyzes intermediate results    │
 * │    └── Synthesize step → LLM generates grounded answer      │
 * │ 4. ASSEMBLE — combine answer + sources + trace + metadata   │
 * │ 5. RETURN the complete IOrchestratorResponse                │
 * └─────────────────────────────────────────────────────────────┘
 *
 * Key Design Decisions:
 * - The orchestrator depends on INTERFACES (ILLMClient, ISearchClient), not
 *   concrete classes. This is DIP in action.
 * - Each request gets its own RetrievalService and TraceService instances
 *   (per-request lifecycle — no state leaking between requests).
 * - Steps with no dependencies run in PARALLEL (Promise.all).
 * - Steps with dependencies run SEQUENTIALLY after their deps complete.
 * - If a step fails, the orchestrator continues with remaining steps
 *   (graceful degradation, not crash).
 */
export class OrchestratorService {
  private readonly llmClient: ILLMClient;
  private readonly searchClient: ISearchClient;

  /**
   * Constructor receives dependencies via interfaces.
   *
   * Why constructor injection?
   * - Makes dependencies explicit (you can see what the orchestrator needs)
   * - Makes testing easy (pass mock implementations)
   * - Follows DIP — depends on abstractions, not concretions
   *
   * @param llmClient - Any implementation of ILLMClient
   * @param searchClient - Any implementation of ISearchClient
   */
  constructor(llmClient: ILLMClient, searchClient: ISearchClient) {
    this.llmClient = llmClient;
    this.searchClient = searchClient;
  }

  /**
   * Create a default search plan without calling the LLM.
   * For most queries, a simple "search then synthesize" plan is sufficient.
   * This saves an entire LLM round-trip (~3-5 seconds).
   */
  private createDefaultPlan(query: string): IOrchestratorStep[] {
    return [
      {
        id: "step_1",
        type: "search" as const,
        description: "Search for information about the query",
        query: query,
        dependsOn: [],
      },
    ];
  }

  // ---------------------------------------------------------------------------
  // Main orchestration method
  // ---------------------------------------------------------------------------

  /**
   * Process a user request through the full orchestration pipeline.
   * This is the main entry point — called by the route handler.
   *
   * @param request - The user's request (query + requestId)
   * @returns Complete orchestrator response with answer, sources, trace, metadata
   */
  async processRequest(request: IUserRequest): Promise<IOrchestratorResponse> {
    const timeoutMs = config.requestTimeoutMs;

    // Race the actual work against a timeout
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new RequestTimeoutError(timeoutMs)), timeoutMs);
    });

    return Promise.race([this._executeRequest(request), timeoutPromise]);
  }

  /**
   * Stream the orchestration response using Server-Sent Events.
   * Instead of waiting for the full response, yields events as work progresses:
   * status → sources → chunk (many) → metadata → done
   *
   * @param request - The user's request
   * @yields IStreamEvent objects for each stage of processing
   */
  async *processRequestStream(
    request: IUserRequest,
  ): AsyncGenerator<IStreamEvent> {
    const retrievalService = new RetrievalService();
    const traceService = new TraceService(request.requestId);
    const tokenUsage = { input: 0, output: 0 };
    const allSources: ISource[] = [];
    const allStepResults: IStepResult[] = [];

    try {
      // Phase 1: PLAN — Create a default search plan (no LLM call)
      yield { type: "status", message: "Planning research strategy..." };
      const steps = this.createDefaultPlan(request.query);
      traceService.startStep(
        "planning",
        "analyze",
        "Generate execution plan",
        request.query,
      );
      traceService.endStep("planning", `Planned ${steps.length} steps`, 0);

      // Phase 2: EXECUTE — run search steps
      yield { type: "status", message: "Searching public sources..." };
      const executionLayers = this.buildExecutionLayers(steps);

      for (const layer of executionLayers) {
        const layerPromises = layer.map((step) =>
          this.executeStep(
            step,
            allStepResults,
            retrievalService,
            traceService,
          ),
        );
        const layerResults = await Promise.allSettled(layerPromises);

        for (let i = 0; i < layerResults.length; i++) {
          const result = layerResults[i];
          const step = layer[i];
          if (!step) continue;

          if (result?.status === "fulfilled" && result.value) {
            allStepResults.push(result.value);
            allSources.push(...result.value.sources);
          } else if (result?.status === "rejected") {
            allStepResults.push({
              stepId: step.id,
              status: "failed" as StepStatus,
              sources: [],
              output: "",
              error:
                result.reason instanceof Error
                  ? result.reason.message
                  : String(result.reason),
              durationMs: 0,
            });
          }
        }
      }

      // Send sources to client immediately after search completes
      const uniqueSources = this.deduplicateSources(allSources);
      yield { type: "sources", sources: uniqueSources };

      // Phase 3: SYNTHESIZE — stream the answer
      yield { type: "status", message: "Synthesizing answer..." };
      const relevantSnippets = retrievalService.getRelevantSnippets(
        request.query,
        10,
      );
      traceService.startStep(
        "synthesis",
        "synthesize",
        "Generate grounded answer",
        request.query,
      );

      // Build the same prompt as generateResponse
      const contextStr = relevantSnippets
        .map(
          (snippet: ISnippet, i: number) =>
            `[Source ${i + 1}] ${snippet.source.title}\nURL: ${snippet.source.url}\nContent: ${snippet.content}\n`,
        )
        .join("\n---\n");

      const stepsStr = allStepResults
        .map(
          (step) =>
            `Step ${step.stepId} (${step.status}): ${step.output || step.error || "No output"}`,
        )
        .join("\n");

      const systemPrompt = `You are a research assistant that produces grounded, well-cited answers. You MUST follow these rules:

CITATION RULES:
1. Every factual claim MUST be supported by at least one of the provided sources.
2. Use inline citations in this format: [Source Title](URL)
3. If NO source supports a claim, explicitly state "I could not find a source to verify this."
4. If sources CONFLICT, mention both perspectives and note the disagreement.
5. NEVER make up information not found in the provided sources.

CONFIDENCE RULES:
- "high": 3+ credible sources agree on the key claims
- "medium": 1-2 sources found, or some claims lack verification
- "low": Few/no relevant sources, significant conflicts, or poor source quality

Write a detailed answer with inline [citations](urls). Do NOT use JSON format — write natural prose.`;

      const userMessage = `USER QUESTION: ${request.query}

RETRIEVED SOURCES:
${contextStr || "No sources were retrieved."}

STEP RESULTS:
${stepsStr || "No step results available."}

Based on the above sources, provide a grounded answer with citations.`;

      // Stream the answer from the LLM
      const generator = this.llmClient.streamComplete(
        [{ role: "user", content: userMessage }],
        { systemPrompt, temperature: 0.3, maxTokens: 2048 },
      );

      let streamResult = await generator.next();
      while (!streamResult.done) {
        yield { type: "chunk", content: streamResult.value };
        streamResult = await generator.next();
      }

      // streamResult.value is the ITokenUsage return value
      const usage = streamResult.value;
      tokenUsage.input += usage.inputTokens;
      tokenUsage.output += usage.outputTokens;
      traceService.endStep("synthesis", "Streamed grounded answer", 0);

      // Phase 4: Send metadata
      const metadata = this.buildMetadata(
        traceService,
        allStepResults,
        uniqueSources,
        tokenUsage,
      );
      yield { type: "metadata", metadata };
      yield { type: "done" };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      yield { type: "error", message: errorMsg };
    }
  }

  /**
   * Internal method containing the actual orchestration logic.
   * Separated from processRequest so the timeout wrapper stays clean.
   */
  private async _executeRequest(
    request: IUserRequest,
  ): Promise<IOrchestratorResponse> {
    // Create per-request service instances
    const retrievalService = new RetrievalService();
    const traceService = new TraceService(request.requestId);

    // Per-request token accumulator — tracks usage across all LLM calls for this request.
    // This is a local variable, not shared state, so concurrent requests are safe.
    const tokenUsage = { input: 0, output: 0 };

    // Collect all sources across all steps
    const allSources: ISource[] = [];
    const allStepResults: IStepResult[] = [];

    try {
      // -----------------------------------------------------------------------
      // Phase 1: PLAN — Create a default search plan (no LLM call)
      // -----------------------------------------------------------------------
      traceService.startStep(
        "planning",
        "analyze",
        "Generate execution plan",
        request.query,
      );

      let steps: IOrchestratorStep[];
      try {
        // Use a default plan instead of asking the LLM to plan.
        // This saves an entire LLM round-trip (~3-5 seconds).
        steps = this.createDefaultPlan(request.query);

        // Safety limit — prevent runaway plans
        if (steps.length > config.maxOrchestrationSteps) {
          steps = steps.slice(0, config.maxOrchestrationSteps);
          console.warn(
            `Plan truncated from ${steps.length} to ${config.maxOrchestrationSteps} steps`,
          );
        }

        // Guard against empty plans (defensive — createDefaultPlan always returns 1+)
        if (steps.length === 0) {
          traceService.endStep("planning", "Empty plan generated", 0);
          return this.buildErrorResponse(
            request,
            traceService,
            "No steps were generated. Please rephrase your query.",
          );
        }

        traceService.endStep(
          "planning",
          `Planned ${steps.length} steps: ${steps.map((s) => s.description).join(", ")}`,
          0,
        );
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        traceService.failStep("planning", errorMsg);

        // If planning fails, return a graceful error response
        return this.buildErrorResponse(
          request,
          traceService,
          `Failed to generate execution plan: ${errorMsg}`,
        );
      }

      // -----------------------------------------------------------------------
      // Phase 2: EXECUTE — Run steps respecting dependencies
      // -----------------------------------------------------------------------
      const completedStepIds = new Set<string>();

      // Separate steps into dependency layers for execution ordering
      const executionLayers = this.buildExecutionLayers(steps);

      for (const layer of executionLayers) {
        // All steps in a layer have their dependencies met → run in parallel
        const layerPromises = layer.map((step) =>
          this.executeStep(
            step,
            allStepResults,
            retrievalService,
            traceService,
          ),
        );

        const layerResults = await Promise.allSettled(layerPromises);

        // Process results from this layer
        for (let i = 0; i < layerResults.length; i++) {
          const result = layerResults[i];
          const step = layer[i];

          if (!step) continue;

          if (result?.status === "fulfilled" && result.value) {
            allStepResults.push(result.value);
            allSources.push(...result.value.sources);
            completedStepIds.add(step.id);
          } else if (result?.status === "rejected") {
            // Step failed — record it but continue
            const errorMsg =
              result.reason instanceof Error
                ? result.reason.message
                : String(result.reason);

            allStepResults.push({
              stepId: step.id,
              status: "failed" as StepStatus,
              sources: [],
              output: "",
              error: errorMsg,
              durationMs: 0,
            });
          }
        }
      }

      // Skip any steps whose dependencies weren't met
      for (const step of steps) {
        if (
          !completedStepIds.has(step.id) &&
          !allStepResults.some((r) => r.stepId === step.id)
        ) {
          traceService.skipStep(
            step.id,
            step.type,
            step.description,
            "Dependencies not met",
          );
        }
      }

      // -----------------------------------------------------------------------
      // Phase 3: SYNTHESIZE — Generate grounded answer from collected data
      // -----------------------------------------------------------------------
      traceService.startStep(
        "synthesis",
        "synthesize",
        "Generate grounded answer",
        request.query,
      );

      // Get the most relevant snippets from the RAG store
      const relevantSnippets = retrievalService.getRelevantSnippets(
        request.query,
        10,
      );

      let groundedAnswer;
      try {
        const responseResult = await this.llmClient.generateResponse(
          request.query,
          relevantSnippets,
          allStepResults,
        );
        groundedAnswer = responseResult.answer;
        tokenUsage.input += responseResult.tokenUsage.inputTokens;
        tokenUsage.output += responseResult.tokenUsage.outputTokens;
        traceService.endStep(
          "synthesis",
          `Generated answer with ${groundedAnswer.citations.length} citations, ` +
            `confidence: ${groundedAnswer.confidence}`,
          0,
        );
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        traceService.failStep("synthesis", errorMsg);

        // If synthesis fails but we have sources, still return what we found
        groundedAnswer = {
          answer:
            "I was unable to synthesize a complete answer, but here are the sources I found. " +
            `Error: ${errorMsg}`,
          citations: [],
          confidence: "low" as const,
          caveats: [
            "The synthesis step failed. The sources below may still be helpful.",
            errorMsg,
          ],
        };
      }

      // -----------------------------------------------------------------------
      // Phase 4: ASSEMBLE — Build the final response
      // -----------------------------------------------------------------------

      // Deduplicate sources by URL
      const uniqueSources = this.deduplicateSources(allSources);

      // Build metadata
      const metadata = this.buildMetadata(
        traceService,
        allStepResults,
        uniqueSources,
        tokenUsage,
      );

      return {
        requestId: request.requestId,
        query: request.query,
        answer: groundedAnswer,
        sources: uniqueSources,
        trace: traceService.getTrace(),
        metadata,
      };
    } catch (error) {
      // Catch-all for unexpected errors
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(
        `Orchestration error for request ${request.requestId}:`,
        errorMsg,
      );

      return this.buildErrorResponse(request, traceService, errorMsg);
    }
  }

  // ---------------------------------------------------------------------------
  // Step execution
  // ---------------------------------------------------------------------------

  /**
   * Execute a single orchestration step based on its type.
   *
   * This is the "dispatcher" — it routes each step to the appropriate handler.
   * Adding a new step type only requires adding a new case here (OCP).
   *
   * @param step - The step to execute
   * @param previousResults - Results from previously completed steps
   * @param retrievalService - The RAG store for this request
   * @param traceService - The trace collector for this request
   * @returns The step result
   */
  private async executeStep(
    step: IOrchestratorStep,
    previousResults: IStepResult[],
    retrievalService: RetrievalService,
    traceService: TraceService,
  ): Promise<IStepResult> {
    const startTime = Date.now();
    traceService.startStep(step.id, step.type, step.description, step.query);

    try {
      let result: IStepResult;

      switch (step.type) {
        case "search":
          result = await this.executeSearchStep(step, retrievalService);
          break;
        case "analyze":
          result = await this.executeAnalyzeStep(step, previousResults);
          break;
        case "synthesize":
          // Synthesize is handled in the main flow (Phase 3), not here
          // If the LLM plans a "synthesize" step, we treat it as an analyze step
          result = await this.executeAnalyzeStep(step, previousResults);
          break;
        default:
          // Unknown step type — skip it gracefully
          result = {
            stepId: step.id,
            status: "skipped",
            sources: [],
            output: `Unknown step type: ${step.type}`,
            durationMs: Date.now() - startTime,
          };
      }

      traceService.endStep(
        step.id,
        result.output.slice(0, 200), // Truncate for trace readability
        result.sources.length,
      );

      return result;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const durationMs = Date.now() - startTime;

      traceService.failStep(step.id, errorMsg);

      return {
        stepId: step.id,
        status: "failed",
        sources: [],
        output: "",
        error: errorMsg,
        durationMs,
      };
    }
  }

  /**
   * Execute a search step — queries public sources via the search client.
   *
   * @param step - The search step
   * @param retrievalService - The RAG store to add results to
   * @returns Step result with sources
   */
  private async executeSearchStep(
    step: IOrchestratorStep,
    retrievalService: RetrievalService,
  ): Promise<IStepResult> {
    const startTime = Date.now();

    const searchResult = await this.searchClient.search(step.query, {
      maxResults: config.maxSearchResults,
      searchDepth: "basic",
      includeAnswer: true,
    });

    // Add to RAG store for later retrieval
    retrievalService.addFromSources(searchResult.sources);

    const sourceSummary = searchResult.sources
      .map((s) => `- ${s.title} (${s.url})`)
      .join("\n");

    return {
      stepId: step.id,
      status: "completed",
      sources: searchResult.sources,
      output:
        searchResult.answer ||
        `Found ${searchResult.sources.length} sources:\n${sourceSummary}`,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Execute an analyze step — uses LLM to analyze/compare data.
   *
   * @param step - The analyze step
   * @param previousResults - Results from earlier steps for context
   * @returns Step result with analysis output
   */
  private async executeAnalyzeStep(
    step: IOrchestratorStep,
    previousResults: IStepResult[],
  ): Promise<IStepResult> {
    const startTime = Date.now();

    // Build context from previous step outputs
    const context = previousResults
      .filter((r) => r.status === "completed")
      .map((r) => r.output)
      .join("\n\n");

    const response = await this.llmClient.complete(
      [
        {
          role: "user",
          content: `Based on the following information:\n\n${context}\n\nPlease: ${step.query}`,
        },
      ],
      {
        systemPrompt:
          "You are a research analyst. Analyze the provided information concisely.",
        temperature: 0.3,
        maxTokens: 1024,
      },
    );

    return {
      stepId: step.id,
      status: "completed",
      sources: [],
      output: response.content,
      durationMs: Date.now() - startTime,
    };
  }

  // ---------------------------------------------------------------------------
  // Execution ordering — dependency resolution
  // ---------------------------------------------------------------------------

  /**
   * Build execution layers from the dependency graph.
   *
   * This is a simplified topological sort. Steps are grouped into "layers":
   * - Layer 0: Steps with no dependencies (run in parallel)
   * - Layer 1: Steps that depend only on Layer 0 steps (run after Layer 0)
   * - Layer 2: Steps that depend on Layer 0 or 1 steps (run after Layer 1)
   * - ...and so on
   *
   * Example:
   *   step_1 (search, no deps)  ]
   *   step_2 (search, no deps)  ] → Layer 0 (parallel)
   *   step_3 (analyze, depends on step_1, step_2) → Layer 1 (sequential after Layer 0)
   *   step_4 (synthesize, depends on step_3) → Layer 2 (sequential after Layer 1)
   *
   * Why layers instead of full topological sort?
   * - Simpler to implement and understand
   * - Each layer runs in parallel with Promise.all — natural parallelism
   * - Good enough for 2-5 steps (YAGNI — no need for a complex DAG executor)
   *
   * @param steps - The planned orchestration steps
   * @returns Array of layers, each containing steps that can run in parallel
   */
  private buildExecutionLayers(
    steps: IOrchestratorStep[],
  ): IOrchestratorStep[][] {
    const layers: IOrchestratorStep[][] = [];
    const assigned = new Set<string>();

    // Filter out "synthesize" steps — synthesis is handled separately in Phase 3
    const executableSteps = steps.filter((step) => step.type !== "synthesize");

    // Safety: max iterations to prevent infinite loop on circular deps
    const maxIterations = executableSteps.length + 1;
    let iteration = 0;

    while (
      assigned.size < executableSteps.length &&
      iteration < maxIterations
    ) {
      const layer: IOrchestratorStep[] = [];

      for (const step of executableSteps) {
        if (assigned.has(step.id)) continue;

        // Check if all dependencies are satisfied
        const depsResolved = step.dependsOn.every((depId) =>
          assigned.has(depId),
        );

        if (depsResolved) {
          layer.push(step);
        }
      }

      if (layer.length === 0) {
        // No steps can be executed — remaining steps have unresolvable deps
        // Assign them all to the last layer to avoid infinite loop
        const remaining = executableSteps.filter((s) => !assigned.has(s.id));
        if (remaining.length > 0) {
          layers.push(remaining);
          remaining.forEach((s) => assigned.add(s.id));
        }
        break;
      }

      layers.push(layer);
      layer.forEach((step) => assigned.add(step.id));
      iteration++;
    }

    return layers;
  }

  // ---------------------------------------------------------------------------
  // Response builders
  // ---------------------------------------------------------------------------

  /**
   * Deduplicate sources by URL.
   * Multiple search steps might find the same source.
   * Keep the one with the highest relevance score.
   */
  private deduplicateSources(sources: ISource[]): ISource[] {
    const sourceMap = new Map<string, ISource>();

    for (const source of sources) {
      const existing = sourceMap.get(source.url);
      if (!existing || source.relevanceScore > existing.relevanceScore) {
        sourceMap.set(source.url, source);
      }
    }

    return Array.from(sourceMap.values());
  }

  private buildMetadata(
    traceService: TraceService,
    _stepResults: IStepResult[],
    sources: ISource[],
    tokenUsage: { input: number; output: number },
  ): IResponseMetadata {
    const counts = traceService.getStepCounts();

    return {
      totalDurationMs: traceService.getTotalDurationMs(),
      stepsExecuted: counts.executed,
      stepsFailed: counts.failed,
      sourcesRetrieved: sources.length,
      llmTokensUsed: {
        input: tokenUsage.input,
        output: tokenUsage.output,
      },
    };
  }

  /**
   * Build a graceful error response.
   * Even when things go wrong, we return a structured response — not a crash.
   */
  private buildErrorResponse(
    request: IUserRequest,
    traceService: TraceService,
    errorMessage: string,
  ): IOrchestratorResponse {
    return {
      requestId: request.requestId,
      query: request.query,
      answer: {
        answer: `I was unable to fully answer your question due to an error: ${errorMessage}. Please try again.`,
        citations: [],
        confidence: "low",
        caveats: [errorMessage],
      },
      sources: [],
      trace: traceService.getTrace(),
      metadata: {
        totalDurationMs: traceService.getTotalDurationMs(),
        stepsExecuted: 0,
        stepsFailed: 1,
        sourcesRetrieved: 0,
        llmTokensUsed: { input: 0, output: 0 },
      },
    };
  }
}
