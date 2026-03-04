// =============================================================================
// src/services/trace.service.ts
// Lightweight execution trace collector.
// Records what happened at each step for transparency and debugging.
// Follows SRP — only handles tracing, no business logic.
// =============================================================================

import { ITrace, ITraceEntry, StepType } from "../interfaces";

/**
 * TraceService — records the execution trace for one orchestration request.
 *
 * What is a trace?
 * A trace is a chronological record of everything the orchestrator did:
 * - Which steps were planned
 * - When each step started and ended
 * - What each step produced (or what error it hit)
 * - How long each step took
 *
 * Why traceability?
 * The assessment requires it:
 * > "Show a lightweight trace of what happened: the steps chosen,
 * >  what was retrieved and how it contributed to the final answer."
 *
 * Lifecycle:
 * - Created fresh for EACH orchestration request (like RetrievalService)
 * - Steps are recorded as the orchestrator executes them
 * - Final trace is included in the response
 *
 * Design:
 * - Non-invasive — recording a trace never throws or affects orchestration
 * - All methods are safe to call even with bad data (defensive)
 */
export class TraceService {
  private readonly requestId: string;
  private readonly entries: Map<string, ITraceEntry>;
  private readonly startTime: Date;

  constructor(requestId: string) {
    this.requestId = requestId;
    this.entries = new Map();
    this.startTime = new Date();
  }

  // ---------------------------------------------------------------------------
  // Recording methods — called by the orchestrator during execution
  // ---------------------------------------------------------------------------

  /**
   * Record the start of a step.
   * Called when the orchestrator begins executing a step.
   *
   * @param stepId - Unique step identifier
   * @param stepType - "search" | "analyze" | "synthesize"
   * @param description - Human-readable description of what this step does
   * @param input - What was sent (the search query or analysis prompt)
   */
  startStep(
    stepId: string,
    stepType: StepType,
    description: string,
    input: string,
  ): void {
    const entry: ITraceEntry = {
      stepId,
      stepType,
      description,
      status: "running",
      startTime: new Date(),
      input,
      sourcesFound: 0,
    };
    this.entries.set(stepId, entry);
  }

  /**
   * Record the successful completion of a step.
   *
   * @param stepId - The step that completed
   * @param output - Summary of what was produced
   * @param sourcesFound - Number of sources retrieved (for search steps)
   */
  endStep(stepId: string, output: string, sourcesFound: number = 0): void {
    const entry = this.entries.get(stepId);
    if (!entry) {
      // Defensive — if startStep wasn't called, create a minimal entry
      console.warn(`TraceService: endStep called for unknown step "${stepId}"`);
      return;
    }

    const endTime = new Date();
    const updatedEntry: ITraceEntry = {
      ...entry,
      status: "completed",
      endTime,
      durationMs: endTime.getTime() - entry.startTime.getTime(),
      output,
      sourcesFound,
    };
    this.entries.set(stepId, updatedEntry);
  }

  /**
   * Record the failure of a step.
   *
   * @param stepId - The step that failed
   * @param error - The error message
   */
  failStep(stepId: string, error: string): void {
    const entry = this.entries.get(stepId);
    if (!entry) {
      console.warn(
        `TraceService: failStep called for unknown step "${stepId}"`,
      );
      return;
    }

    const endTime = new Date();
    const updatedEntry: ITraceEntry = {
      ...entry,
      status: "failed",
      endTime,
      durationMs: endTime.getTime() - entry.startTime.getTime(),
      error,
    };
    this.entries.set(stepId, updatedEntry);
  }

  /**
   * Record a step that was skipped (e.g., dependency failed).
   *
   * @param stepId - The step that was skipped
   * @param stepType - The type of step
   * @param description - Why it was skipped
   */
  skipStep(
    stepId: string,
    stepType: StepType,
    description: string,
    reason: string,
  ): void {
    const entry: ITraceEntry = {
      stepId,
      stepType,
      description,
      status: "skipped",
      startTime: new Date(),
      endTime: new Date(),
      durationMs: 0,
      input: "",
      output: `Skipped: ${reason}`,
      sourcesFound: 0,
    };
    this.entries.set(stepId, entry);
  }

  // ---------------------------------------------------------------------------
  // Output methods — called when building the final response
  // ---------------------------------------------------------------------------

  /**
   * Build the complete trace object for the API response.
   * Generates a human-readable summary of what happened.
   *
   * @returns The complete ITrace object
   */
  getTrace(): ITrace {
    const entriesArray = Array.from(this.entries.values());

    return {
      requestId: this.requestId,
      entries: entriesArray,
      summary: this.generateSummary(entriesArray),
    };
  }

  /**
   * Get the total duration of the orchestration (from creation to now).
   */
  getTotalDurationMs(): number {
    return new Date().getTime() - this.startTime.getTime();
  }

  /**
   * Get counts of steps by status.
   */
  getStepCounts(): { executed: number; failed: number; skipped: number } {
    let executed = 0;
    let failed = 0;
    let skipped = 0;

    for (const entry of this.entries.values()) {
      if (entry.status === "completed") executed++;
      else if (entry.status === "failed") failed++;
      else if (entry.status === "skipped") skipped++;
    }

    return { executed, failed, skipped };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Generate a human-readable summary of the trace.
   *
   * Example output:
   * "Executed 3 steps in 2.5s: 2 searches (found 8 sources), 1 synthesis.
   *  1 step failed (search for 'XYZ')."
   *
   * Why a summary?
   * - The raw trace entries are detailed but verbose
   * - A one-line summary gives quick insight into what happened
   * - Useful for logs and for users who don't want to read the full trace
   */
  private generateSummary(entries: ITraceEntry[]): string {
    const totalDuration = (this.getTotalDurationMs() / 1000).toFixed(1);
    const completed = entries.filter((e) => e.status === "completed");
    const failed = entries.filter((e) => e.status === "failed");
    const skipped = entries.filter((e) => e.status === "skipped");
    const totalSources = entries.reduce((sum, e) => sum + e.sourcesFound, 0);

    const parts: string[] = [];

    parts.push(
      `Executed ${completed.length} of ${entries.length} steps in ${totalDuration}s`,
    );

    if (totalSources > 0) {
      parts.push(`retrieved ${totalSources} sources`);
    }

    if (failed.length > 0) {
      const failedNames = failed.map((e) => e.description).join(", ");
      parts.push(`${failed.length} step(s) failed: ${failedNames}`);
    }

    if (skipped.length > 0) {
      parts.push(`${skipped.length} step(s) skipped`);
    }

    return parts.join(". ") + ".";
  }
}
