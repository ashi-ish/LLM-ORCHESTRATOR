// =============================================================================
// src/config/index.ts
// Loads and validates all environment variables at startup.
// Follows 12-Factor App — config lives in the environment, not in code.
// Fail fast — if required config is missing, the app won't start.
// =============================================================================

import dotenv from "dotenv";
import { IConfig } from "../interfaces";

// Load .env file into process.env
// This MUST be called before accessing any env vars
dotenv.config();

/**
 * Helper to read an env var and throw if it's missing.
 * "Fail fast" principle — don't let the app start with invalid config.
 *
 * @param key - The environment variable name
 * @returns The value as a string
 * @throws Error if the variable is not set
 */
function requireEnv(key: string): string {
  const value = process.env[key];
  if (value === undefined || value.trim() === "") {
    throw new Error(
      `Missing required environment variable: ${key}. ` +
        `Please set it in your .env file. See .env.example for reference.`,
    );
  }
  return value;
}

/**
 * Helper to read an optional env var with a default value.
 *
 * @param key - The environment variable name
 * @param defaultValue - Fallback if the var is not set
 * @returns The value or the default
 */
function optionalEnv(key: string, defaultValue: string): string {
  const value = process.env[key];
  return value !== undefined && value.trim() !== "" ? value : defaultValue;
}

/**
 * Parses and validates a numeric env var.
 *
 * @param key - The environment variable name
 * @param defaultValue - Fallback if the var is not set
 * @returns The parsed integer
 * @throws Error if the value is not a valid number
 */
function numericEnv(key: string, defaultValue: number): number {
  const raw = optionalEnv(key, String(defaultValue));
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed)) {
    throw new Error(
      `Environment variable ${key} must be a valid number. Got: "${raw}"`,
    );
  }
  return parsed;
}

/**
 * Build the application configuration from environment variables.
 * Called once at startup. The result is an immutable IConfig object.
 *
 * Why a function and not a top-level const?
 * - It's testable (can be called with different env setups)
 * - It's explicit about when config loading happens
 * - Errors are thrown at a predictable point in the startup sequence
 */
function loadConfig(): IConfig {
  return Object.freeze({
    anthropicApiKey: requireEnv("ANTHROPIC_API_KEY"),
    anthropicModel: optionalEnv("ANTHROPIC_MODEL", "claude-sonnet-4-20250514"),
    tavilyApiKey: requireEnv("TAVILY_API_KEY"),
    port: numericEnv("PORT", 3000),
    maxSearchResults: numericEnv("MAX_SEARCH_RESULTS", 5),
    maxOrchestrationSteps: numericEnv("MAX_ORCHESTRATION_STEPS", 5),
    logLevel: optionalEnv("LOG_LEVEL", "info"),
    requestTimeoutMs: numericEnv("REQUEST_TIMEOUT_MS", 30000),
  });
}

/**
 * The singleton config instance.
 * Exported as a const — imported by every module that needs config.
 *
 * Object.freeze() in loadConfig() ensures nobody can mutate this.
 * Combined with `readonly` in IConfig, we get compile-time AND runtime immutability.
 */
export const config: IConfig = loadConfig();
