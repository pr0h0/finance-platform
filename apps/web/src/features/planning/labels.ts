// User-facing names for planning enums (domain values stay as stored).
import type { Confidence, Priority } from '@finplat/domain';

export const CONFIDENCE_LABEL: Record<Confidence, string> = {
  certain: 'Confirmed',
  expected: 'Estimated',
  possible: 'Uncertain',
  speculative: 'Speculative',
};

export const PRIORITY_LABEL: Record<Priority, string> = {
  essential: 'Essential',
  high: 'High',
  normal: 'Normal',
  low: 'Deferrable',
  optional: 'Optional',
};
