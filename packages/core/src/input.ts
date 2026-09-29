/**
 * Input validation helpers for the Agent core.
 *
 * A valid user input is any string that contains at least one
 * non-whitespace character. Empty and whitespace-only inputs are rejected.
 */

/**
 * Returns true only when the input contains at least one non-whitespace
 * character. Empty strings and whitespace-only strings are considered invalid.
 */
export function isValidInput(input: string): boolean {
  return input.trim().length > 0;
}
