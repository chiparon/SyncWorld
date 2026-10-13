import type { RunStatus, StatusFormatOptions } from '../schema/types.ts';

/**
 * Renders a run's status as plain text for a terminal, without a trailing
 * newline. `syncw status` prints it.
 *
 * PLACEHOLDER: the real report is a separate task. Until it lands, this
 * prints the raw data, so the command around it already works end to end.
 */
export function formatRunStatus(status: RunStatus, _opts: StatusFormatOptions = {}): string {
  return JSON.stringify(status, null, 2);
}
