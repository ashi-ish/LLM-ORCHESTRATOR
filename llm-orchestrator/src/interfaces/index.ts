// =============================================================================
// src/interfaces/index.ts
// Central type definitions for the entire application.
// Every interface, type, and enum used across module boundaries lives here.
//
// Why a single file?
// - Small project → one file is simpler than many small files
// - Easy to find any type — just search this file
// - Prevents circular dependency issues between modules
// - In a larger project, you'd split into per-domain files
// =============================================================================

// -----------------------------------------------------------------------------
// 1. Configuration
// -----------------------------------------------------------------------------

/**
 * Application configuration loaded from environment variables.
 * All properties are readonly — config is immutable after startup.
 * See config/index.ts for how these are loaded and validated.
 */
export interface IConfig {
  readonly anthropicApiKey: string;
  readonly anthropicModel: string;
  readonly tavilyApiKey: string;
  readonly port: number;
  readonly maxSearchResults: number;
  readonly maxOrchestrationSteps: number;
  readonly logLevel: string;
  readonly requestTimeoutMs: number;
}

// -----------------------------------------------------------------------------
// 2. LLM Client
// -----------------------------------------------------------------------------

/**
 * Represents a single message in a conversation with the LLM.
 */
export interface ILLMMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

/**
 * Options for an LLM completion request.
 */
export interface ILLMRequestOptions {
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly systemPrompt?: string;
}

/**
 * The response from an LLM completion request.
 * Contains the generated text, the model used, and token usage metrics.
 */
export interface ILLMResponse {
  readonly content: string;
  readonly model: string;
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
  };
}

/**
 * Token usage from a single LLM call.
 * Returned alongside results so the orchestrator can track usage per-request
 * without shared mutable state (avoids race conditions).
 */
export interface ITokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/**
 * Result of plan generation — steps + token usage from the underlying LLM call.
 */
export interface IPlanResult {
  readonly steps: IOrchestratorStep[];
  readonly tokenUsage: ITokenUsage;
}

/**
 * Result of grounded response generation — answer + token usage.
 */
export interface IGroundedAnswerResult {
  readonly answer: IGroundedAnswer;
  readonly tokenUsage: ITokenUsage;
}

/**
 * Server-Sent Event types for streaming responses.
 * - status: Progress updates (e.g., "searching...", "synthesizing...")
 * - chunk: A piece of the answer text as it streams from the LLM
 * - sources: The full sources array, sent once search is complete
 * - metadata: Token usage, duration, etc., sent at the end
 * - done: Signals that the stream is complete
 * - error: An error occurred during processing
 */
export type IStreamEvent =
  | { type: "status"; message: string }
  | { type: "chunk"; content: string }
  | { type: "sources"; sources: ISource[] }
  | { type: "metadata"; metadata: IResponseMetadata }
  | { type: "done" }
  | { type: "error"; message: string };

/**
 * Abstraction over any LLM provider (Anthropic, OpenAI, etc.).
 * Follows DIP — the orchestrator depends on this interface, not a concrete SDK.
 * To swap providers, implement this interface with a new class.
 */
export interface ILLMClient {
  /**
   * Generate a plan of steps to answer the user's query.
   * Returns both the steps AND token usage for per-request tracking.
   */
  generatePlan(query: string): Promise<IPlanResult>;

  /**
   * Generate a grounded response using the query and retrieved context.
   * Returns both the answer AND token usage for per-request tracking.
   */
  generateResponse(
    query: string,
    context: ISnippet[],
    steps: IStepResult[],
  ): Promise<IGroundedAnswerResult>;

  /**
   * Send a raw completion request to the LLM.
   * Used internally by generatePlan and generateResponse.
   */
  complete(
    messages: ILLMMessage[],
    options?: ILLMRequestOptions,
  ): Promise<ILLMResponse>;

  /**
   * Stream a completion request to the LLM.
   * Yields text chunks as they arrive from the provider.
   */
  streamComplete(
    messages: ILLMMessage[],
    options?: ILLMRequestOptions,
  ): AsyncGenerator<string, ITokenUsage>;
}

// -----------------------------------------------------------------------------
// 3. Search Client
// -----------------------------------------------------------------------------

/**
 * Options for a search request.
 */
export interface ISearchOptions {
  readonly maxResults?: number;
  readonly searchDepth?: "basic" | "advanced";
  readonly includeAnswer?: boolean;
}

/**
 * A single source retrieved from a public search.
 * Contains the URL, title, content snippet, and a relevance score.
 */
export interface ISource {
  readonly url: string;
  readonly title: string;
  readonly snippet: string;
  readonly relevanceScore: number;
  readonly retrievedAt: Date;
}

/**
 * The full result of a search operation.
 */
export interface ISearchResult {
  readonly query: string;
  readonly sources: ISource[];
  readonly answer?: string; // Some search APIs provide a direct answer
}

/**
 * Abstraction over any search provider (Tavily, SerpAPI, Brave, etc.).
 * Follows DIP — retrieval service depends on this interface, not a concrete API.
 */
export interface ISearchClient {
  /**
   * Search public sources for information related to the query.
   */
  search(query: string, options?: ISearchOptions): Promise<ISearchResult>;
}

// -----------------------------------------------------------------------------
// 4. Orchestrator
// -----------------------------------------------------------------------------

/**
 * The types of steps the orchestrator can execute.
 * - search: Query a search engine for information
 * - analyze: Process/analyze retrieved data
 * - synthesize: Combine findings into a final answer
 */
export type StepType = "search" | "analyze" | "synthesize";

/**
 * The execution status of an orchestration step.
 */
export type StepStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "skipped";

/**
 * A single step in the orchestrator's execution plan.
 * Generated by the LLM during the planning phase.
 */
export interface IOrchestratorStep {
  readonly id: string;
  readonly type: StepType;
  readonly description: string;
  readonly query: string; // The search query or analysis prompt
  readonly dependsOn: string[]; // IDs of steps this depends on (for ordering)
}

/**
 * The result of executing a single orchestration step.
 * Captures status, retrieved sources, output text, and timing.
 */
export interface IStepResult {
  readonly stepId: string;
  readonly status: StepStatus;
  readonly sources: ISource[];
  readonly output: string;
  readonly error?: string;
  readonly durationMs: number;
}

/**
 * The user's incoming request to the orchestrator.
 */
export interface IUserRequest {
  readonly query: string;
  readonly requestId: string;
}

/**
 * A citation linking a specific claim to its source.
 * Used to ground the LLM's answer in retrieved evidence.
 */
export interface ICitation {
  readonly sourceUrl: string;
  readonly sourceTitle: string;
  readonly claim: string; // The specific claim this source supports
}

/**
 * How confident the system is in its answer.
 * - high: 3+ credible sources agree
 * - medium: 1-2 sources, or some claims unverified
 * - low: Few/no sources, conflicts, or poor quality
 */
export type ConfidenceLevel = "high" | "medium" | "low";

/**
 * The LLM's final answer, grounded in retrieved sources.
 * Includes citations, confidence level, and any caveats.
 */
export interface IGroundedAnswer {
  readonly answer: string;
  readonly citations: ICitation[];
  readonly confidence: ConfidenceLevel;
  readonly caveats: string[]; // Any uncertainty, conflicts, or missing info
}

/**
 * The complete orchestrator response returned to the user.
 * This is the shape of the HTTP response body.
 */
export interface IOrchestratorResponse {
  readonly requestId: string;
  readonly query: string;
  readonly answer: IGroundedAnswer;
  readonly sources: ISource[];
  readonly trace: ITrace;
  readonly metadata: IResponseMetadata;
}

/**
 * Metadata about the orchestration run.
 * Useful for monitoring, debugging, and cost tracking.
 */
export interface IResponseMetadata {
  readonly totalDurationMs: number;
  readonly stepsExecuted: number;
  readonly stepsFailed: number;
  readonly sourcesRetrieved: number;
  readonly llmTokensUsed: {
    readonly input: number;
    readonly output: number;
  };
}

// -----------------------------------------------------------------------------
// 5. Tracing
// -----------------------------------------------------------------------------

/**
 * A single entry in the execution trace.
 * Records what happened during one step — timing, status, input/output.
 */
export interface ITraceEntry {
  readonly stepId: string;
  readonly stepType: StepType;
  readonly description: string;
  readonly status: StepStatus;
  readonly startTime: Date;
  readonly endTime?: Date;
  readonly durationMs?: number;
  readonly input: string; // What was sent (query/prompt)
  readonly output?: string; // Summary of what was returned
  readonly sourcesFound: number;
  readonly error?: string;
}

/**
 * The complete execution trace for a request.
 * Provides full observability into what the orchestrator did and why.
 */
export interface ITrace {
  readonly requestId: string;
  readonly entries: ITraceEntry[];
  readonly summary: string; // Human-readable summary of the trace
}

// -----------------------------------------------------------------------------
// 6. RAG (Retrieval-Augmented Generation)
// -----------------------------------------------------------------------------

/**
 * A snippet of content stored in the RAG store.
 * Links content to its source for citation tracking.
 */
export interface ISnippet {
  readonly id: string;
  readonly content: string;
  readonly source: ISource;
  readonly relevanceScore: number;
}

// -----------------------------------------------------------------------------
// 7. Error Handling
// -----------------------------------------------------------------------------

/**
 * Machine-readable error codes for API responses.
 * Clients can switch on these to handle different failure modes.
 */
export enum ErrorCode {
  CONFIG_ERROR = "CONFIG_ERROR",
  LLM_ERROR = "LLM_ERROR",
  LLM_RATE_LIMIT = "LLM_RATE_LIMIT",
  LLM_AUTH_ERROR = "LLM_AUTH_ERROR",
  SEARCH_ERROR = "SEARCH_ERROR",
  SEARCH_NO_RESULTS = "SEARCH_NO_RESULTS",
  ORCHESTRATION_ERROR = "ORCHESTRATION_ERROR",
  VALIDATION_ERROR = "VALIDATION_ERROR",
  INTERNAL_ERROR = "INTERNAL_ERROR",
}

/**
 * Structured error response returned by the API.
 */
export interface IErrorResponse {
  readonly error: {
    readonly code: ErrorCode;
    readonly message: string;
    readonly details?: string;
    readonly requestId?: string;
  };
}

// -----------------------------------------------------------------------------
// 8. Custom Error Classes
// -----------------------------------------------------------------------------

/**
 * Thrown when a request exceeds the configured timeout.
 * Caught by the orchestrator to return a graceful timeout response.
 */
export class RequestTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Request timed out after ${timeoutMs}ms`);
    this.name = "RequestTimeoutError";
  }
}

/**
 * Thrown when an LLM API call fails (after retries are exhausted or on a permanent error).
 */
export class LLMClientError extends Error {
  constructor(
    message: string,
    public readonly isRetryable: boolean = false,
  ) {
    super(message);
    this.name = "LLMClientError";
  }
}

/**
 * Thrown when a search API call fails.
 */
export class SearchClientError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = "SearchClientError";
  }
}
