// =============================================================================
// src/clients/search.client.ts
// Tavily implementation of ISearchClient.
// Follows DIP — the orchestrator depends on ISearchClient, not this class.
// Follows SRP — this module ONLY handles web searching.
// =============================================================================

import axios, { AxiosError, AxiosInstance } from "axios";
import {
  ISearchClient,
  ISearchOptions,
  ISearchResult,
  ISource,
  SearchClientError,
} from "../interfaces";
import { config } from "../config";

/**
 * Shape of a single result from the Tavily API.
 * This is Tavily's format — we transform it to our ISource format.
 */
interface TavilyResult {
  title: string;
  url: string;
  content: string;
  score: number;
  published_date?: string;
}

/**
 * Shape of the raw Tavily API response.
 */
interface TavilyApiResponse {
  query: string;
  answer?: string;
  results: TavilyResult[];
  response_time: number;
}

/**
 * Concrete implementation of ISearchClient using Tavily's search API.
 *
 * Why Tavily?
 * - Built specifically for AI/LLM applications (returns structured data)
 * - Simple REST API — no complex SDK needed
 * - Returns relevance scores we can use for ranking
 *
 * Why axios instead of fetch?
 * - Better error handling than native fetch (typed errors, interceptors)
 * - Automatic JSON parsing
 * - Request/response timeouts built in
 */
export class TavilySearchClient implements ISearchClient {
  private readonly httpClient: AxiosInstance;
  private readonly apiKey: string;
  private readonly defaultMaxResults: number;

  private static readonly BASE_URL = "https://api.tavily.com";

  constructor() {
    this.apiKey = config.tavilyApiKey;
    this.defaultMaxResults = config.maxSearchResults;

    // Create a configured axios instance (not using the global axios)
    // This follows the principle of encapsulation — this HTTP client is
    // scoped to Tavily, with Tavily-specific defaults.
    this.httpClient = axios.create({
      baseURL: TavilySearchClient.BASE_URL,
      timeout: 15000, // 15 seconds Tavily typically responds in 1-3s
      headers: {
        "Content-Type": "application/json",
      },
    });
  }

  // ---------------------------------------------------------------------------
  // ISearchClient.search() — Search public sources for information
  // ---------------------------------------------------------------------------

  /**
   * Search public sources for information related to the query.
   *
   * Flow:
   * 1. Send search request to Tavily API (with retries for transient failures)
   * 2. Parse the raw response into our ISource format
   * 3. Sort by relevance score (highest first)
   * 4. Return structured ISearchResult
   *
   * Retry logic:
   * - Retries up to 3 times with exponential backoff for transient errors
   * - Does NOT retry auth errors (401) or bad requests (400) — those are permanent
   * - Rate limits (429) and server errors (5xx) ARE retried
   *
   * @param query - The search query (like what you'd type into Google)
   * @param options - Optional: maxResults, searchDepth, includeAnswer
   * @returns Structured search results with sources
   */
  async search(
    query: string,
    options?: ISearchOptions,
  ): Promise<ISearchResult> {
    const maxRetries = 3;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await this.httpClient.post<TavilyApiResponse>(
          "/search",
          {
            api_key: this.apiKey,
            query,
            max_results: options?.maxResults ?? this.defaultMaxResults,
            search_depth: options?.searchDepth ?? "basic",
            include_answer: options?.includeAnswer ?? true,
            include_raw_content: false,
          },
        );

        const data = response.data;

        const sources: ISource[] = data.results.map((result) =>
          this.transformToSource(result),
        );

        sources.sort((a, b) => b.relevanceScore - a.relevanceScore);

        return {
          query: data.query,
          sources,
          answer: data.answer,
        };
      } catch (error) {
        lastError = error;

        // Don't retry permanent errors (401, 400, etc.)
        if (!this.isRetryableError(error)) {
          throw this.handleSearchError(error, query);
        }

        // Retry with exponential backoff for transient errors
        if (attempt < maxRetries) {
          const delayMs = Math.pow(2, attempt) * 1000;
          console.warn(
            `Search request failed (attempt ${attempt}/${maxRetries}). ` +
              `Retrying in ${delayMs}ms...`,
          );
          await this.sleep(delayMs);
        }
      }
    }

    // All retries exhausted
    throw this.handleSearchError(lastError, query);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Transform a raw Tavily result into our standardized ISource format.
   *
   * Why a separate method?
   * - SRP: transformation logic is isolated and testable
   * - If Tavily changes their response format, only this method changes
   * - The search() method stays clean and focused on the API call
   *
   * @param result - Raw Tavily API result
   * @returns Standardized ISource object
   */
  private transformToSource(result: TavilyResult): ISource {
    return {
      url: result.url,
      title: result.title || "Untitled Source",
      snippet: this.truncateSnippet(result.content, 500),
      relevanceScore: this.normalizeScore(result.score),
      retrievedAt: new Date(),
    };
  }

  /**
   * Truncate a snippet to a maximum length, breaking at word boundaries.
   *
   * Why truncate?
   * - LLM context windows have limits — we don't want to waste tokens on
   *   very long snippets when the key info is usually in the first few hundred chars.
   * - Keeps the RAG store manageable.
   *
   * Why break at word boundaries?
   * - Cutting mid-word looks unprofessional and can confuse the LLM.
   *
   * @param text - The original text
   * @param maxLength - Maximum character length
   * @returns Truncated text with "..." if it was shortened
   */
  private truncateSnippet(text: string, maxLength: number): string {
    if (!text) return "";
    if (text.length <= maxLength) return text;

    // Find the last space before maxLength to break at a word boundary
    const truncated = text.slice(0, maxLength);
    const lastSpace = truncated.lastIndexOf(" ");

    if (lastSpace > maxLength * 0.8) {
      // Only break at word boundary if it doesn't lose too much text
      return truncated.slice(0, lastSpace) + "...";
    }

    return truncated + "...";
  }

  /**
   * Normalize the relevance score to 0-1 range.
   * Tavily scores are typically 0-1, but we ensure consistency.
   *
   * @param score - Raw score from Tavily
   * @returns Normalized score between 0 and 1
   */
  private normalizeScore(score: number): number {
    if (typeof score !== "number" || isNaN(score)) return 0;
    return Math.max(0, Math.min(1, score));
  }

  /**
   * Transform API errors into meaningful, actionable error messages.
   *
   * Why a dedicated error handler?
   * - Raw axios errors contain tons of noise (full request config, headers, etc.)
   * - Users need actionable messages: "Your API key is invalid" not "Request failed with 401"
   * - Different HTTP status codes need different advice
   *
   * @param error - The caught error
   * @param query - The original query (for context in error messages)
   * @returns A SearchClientError with a clear message and optional status code
   */
  private handleSearchError(error: unknown, query: string): Error {
    if (error instanceof AxiosError) {
      const status = error.response?.status;

      switch (status) {
        case 401:
          return new SearchClientError(
            "Tavily API authentication failed. " +
              "Please check your TAVILY_API_KEY in the .env file.",
            401,
          );
        case 429:
          return new SearchClientError(
            "Tavily API rate limit exceeded. " +
              "Please wait a moment and try again, or upgrade your plan.",
            429,
          );
        case 400:
          return new SearchClientError(
            `Tavily API bad request for query "${query}". ` +
              `Details: ${error.response?.data?.message || error.message}`,
            400,
          );
        default:
          if (error.code === "ECONNABORTED") {
            return new SearchClientError(
              `Tavily API request timed out for query "${query}". ` +
                "The search service may be slow or unavailable.",
            );
          }
          if (error.code === "ENOTFOUND" || error.code === "ECONNREFUSED") {
            return new SearchClientError(
              "Cannot connect to Tavily API. " +
                "Please check your internet connection.",
            );
          }
          return new SearchClientError(
            `Tavily API error (HTTP ${status || "unknown"}): ${error.message}`,
            status,
          );
      }
    }

    // Non-axios error (shouldn't happen, but defensive)
    return new SearchClientError(
      `Unexpected search error for query "${query}": ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  /**
   * Check if an error is retryable (transient network/server issues).
   * Auth errors (401) and bad requests (400) are NOT retryable.
   */
  private isRetryableError(error: unknown): boolean {
    if (error instanceof AxiosError) {
      const status = error.response?.status;
      // Don't retry client errors (except 429 rate limit)
      if (status && status >= 400 && status < 500 && status !== 429) {
        return false;
      }
      return true; // 429, 5xx, network errors are retryable
    }
    return false;
  }

  /**
   * Sleep for the specified duration.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
