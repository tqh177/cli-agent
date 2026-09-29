/**
 * Core error types for the Agent.
 *
 * All domain errors extend AgentError so callers can distinguish
 * expected domain errors from unexpected runtime failures. Each subclass is
 * wrapped with a human-readable message that does not leak sensitive details
 * (such as API keys).
 */

/** Base class for all Agent domain errors. */
export class AgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
    // Restore the prototype chain so `instanceof` works after transpilation.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Raised when a session cannot be loaded (missing id or corrupt data). */
export class SessionLoadError extends AgentError {}

/** Raised when an LLM provider call fails. */
export class LLMError extends AgentError {}

/** Raised when configuration cannot be parsed or validated. */
export class ConfigError extends AgentError {}
