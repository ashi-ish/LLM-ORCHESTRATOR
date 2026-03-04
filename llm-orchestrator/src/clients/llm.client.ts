// =============================================================================
// src/clients/llm.client.ts
// Anthropic Claude implementation of ILLMClient.
// Follows DIP — the orchestrator depends on ILLMClient, not this concrete class.
// Follows OCP — to add OpenAI, create a new class implementing ILLMClient.
// =============================================================================

import Anthropic from "@anthropic-ai/sdk";
import {
  ILLMClient,
  ILLMMessage,
  ILLMRequestOptions,
  ILLMResponse,
  IPlanResult,
  IGroundedAnswerResult,
  IOrchestratorStep,
  IStepResult,
  ISnippet,
  IGroundedAnswer,
  ConfidenceLevel,
  ITokenUsage,
  LLMClientError,
} from "../interfaces";
import { config } from "../config";

/**
 * Concrete implementation of ILLMClient using Anthropic's Claude API.
 *
 * Why implement an interface instead of using the SDK directly?
 * - TypeScript will error if you forget to implement a method
 * - The orchestrator can be tested with a mock ILLMClient
 * - Swapping to OpenAI means creating a new class, not changing existing code (OCP)
 */
export class AnthropicLLMClient implements ILLMClient {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor() {
    this.client = new Anthropic({
      apiKey: config.anthropicApiKey,
    });
    this.model = config.anthropicModel;
  }

  /**
   * Send a completion request to Claude.
   * This is the foundational method — generatePlan and generateResponse use it.
   *
   * Retry Logic:
   * - Retries up to 3 times with exponential backoff for transient errors
   * - Does NOT retry auth errors or invalid requests (those are permanent)
   *
   * @param messages - The conversation messages
   * @param options - Optional parameters (maxTokens, temperature, system prompt)
   * @returns The LLM response with content and token usage
   */
  async complete(
    messages: ILLMMessage[],
    options?: ILLMRequestOptions,
  ): Promise<ILLMResponse> {
    const maxRetries = 3;
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await this.client.messages.create({
          model: this.model,
          max_tokens: options?.maxTokens ?? 4096,
          temperature: options?.temperature ?? 0.3,
          system: options?.systemPrompt ?? "",
          messages: messages.map((msg) => ({
            role: msg.role,
            content: msg.content,
          })),
        });

        // Extract text from the response content blocks
        // Claude returns an array of content blocks; we concatenate text blocks
        const content = response.content
          .filter(
            (block): block is Anthropic.TextBlock => block.type === "text",
          )
          .map((block) => block.text)
          .join("\n");

        return {
          content,
          model: response.model,
          usage: {
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
          },
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Don't retry on auth errors or invalid requests — they won't succeed
        if (this.isPermanentError(error)) {
          throw new LLMClientError(
            `Anthropic API error (non-retryable): ${lastError.message}`,
            false,
          );
        }

        // Retry with exponential backoff for transient errors
        if (attempt < maxRetries) {
          const delayMs = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s
          console.warn(
            `LLM request failed (attempt ${attempt}/${maxRetries}). ` +
              `Retrying in ${delayMs}ms... Error: ${lastError.message}`,
          );
          await this.sleep(delayMs);
        }
      }
    }

    // All retries exhausted
    throw new LLMClientError(
      `Anthropic API request failed after ${maxRetries} attempts: ${lastError?.message}`,
      true,
    );
  }

  // ---------------------------------------------------------------------------
  // ILLMClient.streamComplete() — Stream tokens from Claude
  // ---------------------------------------------------------------------------

  /**
   * Stream a completion request to Claude.
   * Yields text chunks as they arrive, then returns final token usage.
   *
   * Why streaming?
   * - First token arrives in ~1 second instead of waiting 5-10s for full response
   * - Dramatically improves perceived latency for the end user
   * - Uses Anthropic's native streaming API (Server-Sent Events under the hood)
   *
   * @param messages - The conversation messages
   * @param options - Optional parameters (maxTokens, temperature, system prompt)
   * @yields Text chunks as they arrive
   * @returns Token usage after stream completes
   */
  async *streamComplete(
    messages: ILLMMessage[],
    options?: ILLMRequestOptions,
  ): AsyncGenerator<string, ITokenUsage> {
    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: options?.maxTokens ?? 2048,
      temperature: options?.temperature ?? 0.3,
      system: options?.systemPrompt ?? "",
      messages: messages.map((msg) => ({
        role: msg.role as "user" | "assistant",
        content: msg.content,
      })),
    });

    // Yield text chunks as they arrive from Claude
    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        yield event.delta.text;
      }
    }

    // After stream ends, get the final message for token usage
    const finalMessage = await stream.finalMessage();
    return {
      inputTokens: finalMessage.usage.input_tokens,
      outputTokens: finalMessage.usage.output_tokens,
    };
  }

  /**
   * @deprecated Replaced by createDefaultPlan() in OrchestratorService.
   * Kept for interface compliance; not called at runtime.
   */
  async generatePlan(query: string): Promise<IPlanResult> {
    const systemPrompt = `You are a research planning assistant. Your job is to analyze a user's question and create a step-by-step plan to answer it using web searches.

RULES:
1. Break the question into 2-3 focused search queries that together cover the topic.
2. Each search step should target a specific aspect of the question.
3. If steps are independent, they have no dependencies (empty dependsOn array) and can run in parallel.
4. If a step needs results from another step, list the dependency in dependsOn.
5. Always end with a "synthesize" step that depends on all search steps.
6. Keep search queries concise and specific — like what you'd type into Google.

RESPOND WITH ONLY valid JSON in this exact format (no markdown, no backticks, no explanation):
{
  "steps": [
    {
      "id": "step_1",
      "type": "search",
      "description": "Brief description of what this searches for",
      "query": "the actual search query",
      "dependsOn": []
    },
    {
      "id": "step_2",
      "type": "synthesize",
      "description": "Combine findings into a grounded answer",
      "query": "synthesize",
      "dependsOn": ["step_1"]
    }
  ]
}`;

    const response = await this.complete(
      [
        {
          role: "user",
          content: `Create a research plan for this question: "${query}"`,
        },
      ],
      {
        systemPrompt,
        temperature: 0.2, // Low temperature for structured/predictable output
        maxTokens: 1024,
      },
    );

    return {
      steps: this.parsePlanResponse(response.content),
      tokenUsage: {
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // ILLMClient.generateResponse() — Synthesize a grounded answer
  // ---------------------------------------------------------------------------

  /**
   * Generate a grounded, cited answer using the query and retrieved context.
   * Returns the answer AND token usage for per-request tracking.
   *
   * The system prompt enforces citation rules, confidence levels, and JSON format.
   * If parsing fails, parseGroundedResponse provides a graceful fallback.
   */
  async generateResponse(
    query: string,
    context: ISnippet[],
    steps: IStepResult[],
  ): Promise<IGroundedAnswerResult> {
    // Build context string from snippets
    const contextStr = context
      .map(
        (snippet, i) =>
          `[Source ${i + 1}] ${snippet.source.title}\n` +
          `URL: ${snippet.source.url}\n` +
          `Content: ${snippet.content}\n`,
      )
      .join("\n---\n");

    // Build step results summary
    const stepsStr = steps
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

RESPONSE FORMAT — Respond with ONLY valid JSON (no markdown, no backticks):
{
  "answer": "Your detailed answer with inline [citations](urls)...",
  "citations": [
    {
      "sourceUrl": "https://...",
      "sourceTitle": "Source Name",
      "claim": "The specific claim this source supports"
    }
  ],
  "confidence": "high|medium|low",
  "caveats": ["Any uncertainty, missing info, or conflicts noted here"]
}`;

    const userMessage = `USER QUESTION: ${query}

RETRIEVED SOURCES:
${contextStr || "No sources were retrieved."}

STEP RESULTS:
${stepsStr || "No step results available."}

Based on the above sources, provide a grounded answer with citations.`;

    const response = await this.complete(
      [{ role: "user", content: userMessage }],
      {
        systemPrompt,
        temperature: 0.3,
        maxTokens: 2048,
      },
    );

    return {
      answer: this.parseGroundedResponse(response.content),
      tokenUsage: {
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers — parsing, validation, error classification
  // ---------------------------------------------------------------------------

  /**
   * Parse Claude's plan response from JSON text into typed steps.
   * Handles markdown code block wrapping and provides a fallback plan
   * if parsing fails (degrade gracefully, don't crash).
   */
  private parsePlanResponse(content: string): IOrchestratorStep[] {
    try {
      // Claude sometimes wraps JSON in markdown code blocks — strip them
      const cleaned = content
        .replace(/```json\s*/g, "")
        .replace(/```\s*/g, "")
        .trim();

      const parsed = JSON.parse(cleaned) as { steps: IOrchestratorStep[] };

      if (!parsed.steps || !Array.isArray(parsed.steps)) {
        throw new Error("Response missing 'steps' array");
      }

      // Validate each step has required fields
      return parsed.steps.map((step, index) => ({
        id: step.id || `step_${index + 1}`,
        type: step.type || "search",
        description: step.description || `Step ${index + 1}`,
        query: step.query || "",
        dependsOn: Array.isArray(step.dependsOn) ? step.dependsOn : [],
      }));
    } catch (error) {
      console.error("Failed to parse LLM plan response:", error);
      console.error("Raw response:", content);

      // Fallback: create a basic single-search plan
      // This follows the "degrade gracefully" principle
      return [
        {
          id: "step_1",
          type: "search" as const,
          description: "Search for information about the query",
          query: content.slice(0, 200), // Use raw content as query
          dependsOn: [],
        },
        {
          id: "step_2",
          type: "synthesize" as const,
          description: "Synthesize findings into an answer",
          query: "synthesize",
          dependsOn: ["step_1"],
        },
      ];
    }
  }

  /**
   * Parse Claude's grounded response from JSON text into a typed answer.
   * Handles markdown code block wrapping and provides a fallback
   * (raw content with low confidence) if parsing fails.
   */
  private parseGroundedResponse(content: string): IGroundedAnswer {
    try {
      const cleaned = content
        .replace(/```json\s*/g, "")
        .replace(/```\s*/g, "")
        .trim();

      const parsed = JSON.parse(cleaned) as IGroundedAnswer;

      return {
        answer: parsed.answer || "Unable to generate a response.",
        citations: Array.isArray(parsed.citations) ? parsed.citations : [],
        confidence: this.validateConfidence(parsed.confidence),
        caveats: Array.isArray(parsed.caveats) ? parsed.caveats : [],
      };
    } catch (error) {
      console.error("Failed to parse LLM grounded response:", error);
      console.error("Raw response:", content);

      // Fallback: return the raw content as the answer with low confidence
      return {
        answer: content,
        citations: [],
        confidence: "low",
        caveats: [
          "The response could not be parsed into structured format. " +
            "The raw LLM output is provided as-is.",
        ],
      };
    }
  }

  /**
   * Validate and normalize a confidence level string.
   * Returns "low" for any unrecognized value (defensive).
   */
  private validateConfidence(value: unknown): ConfidenceLevel {
    if (value === "high" || value === "medium" || value === "low") {
      return value;
    }
    return "low";
  }

  /**
   * Check if an error is permanent (should not be retried).
   * Auth errors and invalid request errors won't succeed on retry.
   */
  private isPermanentError(error: unknown): boolean {
    if (error instanceof Anthropic.AuthenticationError) return true;
    if (error instanceof Anthropic.BadRequestError) return true;
    if (error instanceof Anthropic.PermissionDeniedError) return true;
    return false;
  }

  /**
   * Promise-based sleep utility for retry backoff.
   * Why not use a library? YAGNI — this is 3 lines of code.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
