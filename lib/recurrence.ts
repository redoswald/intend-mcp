/**
 * Recurrence helpers — port of todopus src/lib/recurrenceHelper.ts.
 * Uses rrule library to compute next occurrence dates.
 */

import { RRule } from "rrule";

export function getNextOccurrence(rruleString: string, afterDate: Date): Date | null {
  try {
    const anchoredAfter = new Date(
      Date.UTC(afterDate.getUTCFullYear(), afterDate.getUTCMonth(), afterDate.getUTCDate(), 12, 0, 0)
    );
    const rule = RRule.fromString(rruleString);
    const next = rule.after(anchoredAfter);
    return next || null;
  } catch {
    return null;
  }
}

export function describeRecurrence(rruleString: string): string {
  try {
    const rule = RRule.fromString(rruleString);
    return rule.toText();
  } catch {
    return rruleString;
  }
}
