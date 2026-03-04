// =============================================================================
// src/services/retrieval.service.ts
// RAG-style snippet store — collects, ranks, and selects relevant snippets.
// Lightweight in-memory implementation. No vector DB, no embeddings.
// Follows KISS — simple keyword-based relevance scoring.
// Follows YAGNI — only what the assessment requires, nothing more.
// =============================================================================

import { v4 as uuidv4 } from "uuid";
import { ISnippet, ISource } from "../interfaces";

/**
 * RetrievalService — the RAG component of the orchestrator.
 *
 * What is RAG?
 * RAG = Retrieval Augmented Generation. Instead of relying solely on the LLM's
 * training data (which can be outdated or hallucinated), we:
 * 1. RETRIEVE relevant documents from external sources
 * 2. STORE them temporarily
 * 3. SELECT the most relevant ones
 * 4. AUGMENT the LLM prompt with this context
 * 5. GENERATE an answer grounded in real data
 *
 * This class handles steps 1-3. The orchestrator handles step 4-5.
 *
 * Why in-memory?
 * - Assessment says "keep it small"
 * - No persistence needed — snippets are per-request
 * - Simple array operations are fast enough for <100 snippets
 * - A vector DB (Pinecone, Chroma, etc.) would be overkill here (YAGNI)
 *
 * Lifecycle:
 * - Created fresh for EACH orchestration request
 * - Snippets accumulate during the search steps
 * - Top-K snippets are selected for the synthesis step
 * - Instance is discarded after the request completes
 */
export class RetrievalService {
  /**
   * The in-memory snippet store.
   * Private — external code uses addSnippets() and getRelevantSnippets().
   */
  private snippets: ISnippet[] = [];

  /**
   * Track seen URLs to avoid duplicate snippets from the same source.
   * A Set provides O(1) lookups — efficient for deduplication.
   */
  private seenUrls: Set<string> = new Set();

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Add snippets from search results into the store.
   * Called after each search step completes.
   *
   * Deduplication:
   * - If a URL has already been added, the snippet is skipped.
   * - Why? Multiple search queries may return the same source. Including
   *   duplicate content wastes LLM context tokens without adding information.
   *
   * @param sources - The sources from a search result
   */
  addFromSources(sources: ISource[]): void {
    for (const source of sources) {
      // Skip duplicates — same URL means same content
      if (this.seenUrls.has(source.url)) {
        continue;
      }

      this.seenUrls.add(source.url);

      const snippet: ISnippet = {
        id: uuidv4(),
        content: source.snippet,
        source,
        relevanceScore: source.relevanceScore,
      };

      this.snippets.push(snippet);
    }
  }

  /**
   * Get the top-K most relevant snippets for the given query.
   *
   * Scoring strategy:
   * We combine TWO signals:
   * 1. The original relevance score from Tavily (how relevant the source was to
   *    the search query that found it)
   * 2. A keyword overlap score (how many words from the user's original query
   *    appear in the snippet content)
   *
   * Why two signals?
   * - Tavily's score tells us how relevant the source was to ONE search query
   * - But the user's original question may be broader than any single search query
   * - Keyword overlap helps prioritize snippets that directly mention the user's topic
   *
   * Why not embeddings/cosine similarity?
   * - Would require an embedding model (extra API call, extra cost, extra latency)
   * - The assessment says "keep it small"
   * - For <100 snippets, keyword scoring is fast and surprisingly effective
   *
   * @param query - The user's original query (for keyword matching)
   * @param topK - How many snippets to return (default: 10)
   * @returns The top-K most relevant snippets, sorted by combined score
   */
  getRelevantSnippets(query: string, topK: number = 10): ISnippet[] {
    if (this.snippets.length === 0) {
      return [];
    }

    // Score each snippet based on combined relevance
    const scored = this.snippets.map((snippet) => ({
      snippet,
      combinedScore: this.calculateCombinedScore(snippet, query),
    }));

    // Sort by combined score descending (most relevant first)
    scored.sort((a, b) => b.combinedScore - a.combinedScore);

    // Return top-K, updating the relevance score to the combined score
    return scored.slice(0, topK).map(({ snippet, combinedScore }) => ({
      ...snippet,
      relevanceScore: combinedScore,
    }));
  }

  /**
   * Get ALL snippets in the store (unranked).
   * Useful for trace/debugging — shows everything that was collected.
   */
  getAllSnippets(): ISnippet[] {
    return [...this.snippets]; // Return a copy to prevent external mutation
  }

  /**
   * Get the total number of snippets stored.
   */
  get count(): number {
    return this.snippets.length;
  }

  /**
   * Clear the store. Called if the service needs to be reset.
   */
  clear(): void {
    this.snippets = [];
    this.seenUrls.clear();
  }

  // ---------------------------------------------------------------------------
  // Private scoring methods
  // ---------------------------------------------------------------------------

  /**
   * Calculate a combined relevance score for a snippet.
   *
   * Formula: combinedScore = (tavilyScore * 0.6) + (keywordScore * 0.4)
   *
   * Why 60/40 weighting?
   * - Tavily's score is computed by a sophisticated search engine — it's a strong signal
   * - Keyword overlap is simpler but adds value for matching the user's exact terms
   * - 60/40 gives more weight to the search engine while still rewarding keyword matches
   *
   * @param snippet - The snippet to score
   * @param query - The user's original query
   * @returns Combined score between 0 and 1
   */
  private calculateCombinedScore(snippet: ISnippet, query: string): number {
    const tavilyScore = snippet.relevanceScore;
    const keywordScore = this.calculateKeywordScore(snippet.content, query);

    return tavilyScore * 0.6 + keywordScore * 0.4;
  }

  /**
   * Calculate a keyword overlap score between the snippet content and the query.
   *
   * How it works:
   * 1. Tokenize both the query and content into lowercase words
   * 2. Remove common stop words (the, is, a, etc.) — they add noise, not signal
   * 3. Count how many query words appear in the content
   * 4. Return the ratio: matchingWords / totalQueryWords
   *
   * Example:
   * - Query: "What are the benefits of TypeScript?"
   * - Query words (after stop word removal): ["benefits", "typescript"]
   * - Content: "TypeScript provides type safety benefits for large projects..."
   * - Matches: "typescript" ✓, "benefits" ✓ → score = 2/2 = 1.0
   *
   * @param content - The snippet text
   * @param query - The user's original query
   * @returns Score between 0 and 1
   */
  private calculateKeywordScore(content: string, query: string): number {
    const queryWords = this.tokenize(query);
    if (queryWords.length === 0) return 0;

    const contentLower = content.toLowerCase();

    // Count how many query words appear in the content
    const matchCount = queryWords.filter((word) =>
      contentLower.includes(word),
    ).length;

    return matchCount / queryWords.length;
  }

  /**
   * Tokenize text into meaningful words.
   *
   * Steps:
   * 1. Lowercase
   * 2. Split on non-alphanumeric characters
   * 3. Remove short words (< 3 chars) — "a", "is", "to" aren't meaningful
   * 4. Remove common English stop words
   *
   * Why remove stop words?
   * - "What are the benefits of TypeScript" → without stop words: ["benefits", "typescript"]
   * - Stop words appear in almost every text — they don't help differentiate relevance
   * - Including them inflates scores for unrelated content
   *
   * @param text - The text to tokenize
   * @returns Array of meaningful lowercase words
   */
  private tokenize(text: string): string[] {
    const stopWords = new Set([
      "the",
      "is",
      "at",
      "which",
      "on",
      "a",
      "an",
      "and",
      "or",
      "but",
      "in",
      "with",
      "to",
      "for",
      "of",
      "not",
      "no",
      "can",
      "had",
      "has",
      "have",
      "was",
      "were",
      "will",
      "would",
      "could",
      "should",
      "may",
      "might",
      "shall",
      "do",
      "does",
      "did",
      "been",
      "being",
      "be",
      "are",
      "am",
      "this",
      "that",
      "these",
      "those",
      "it",
      "its",
      "what",
      "how",
      "why",
      "when",
      "where",
      "who",
      "whom",
      "whose",
      "from",
      "into",
      "about",
      "between",
      "through",
      "during",
      "before",
      "after",
      "above",
      "below",
      "than",
      "more",
      "most",
      "some",
      "any",
      "each",
      "every",
      "all",
      "both",
      "few",
      "many",
      "much",
      "own",
    ]);

    return text
      .toLowerCase()
      .split(/[^a-z0-9]+/) // Split on non-alphanumeric
      .filter(
        (word) =>
          word.length >= 3 && // Remove short words
          !stopWords.has(word), // Remove stop words
      );
  }
}
