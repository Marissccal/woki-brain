/**
 * B1 - Variable Duration by Party Size
 * 
 * Calculates booking duration based on party size using predefined rules.
 * This allows the system to automatically determine appropriate booking durations
 * without requiring explicit duration input from the client.
 */

export interface DurationRule {
  maxPartySize: number;
  durationMinutes: number;
}

/**
 * Default duration rules:
 * - ≤2 people → 75 minutes
 * - ≤4 people → 90 minutes
 * - ≤8 people → 120 minutes
 * - >8 people → 150 minutes
 */
const DEFAULT_DURATION_RULES: DurationRule[] = [
  { maxPartySize: 2, durationMinutes: 75 },
  { maxPartySize: 4, durationMinutes: 90 },
  { maxPartySize: 8, durationMinutes: 120 },
  { maxPartySize: Infinity, durationMinutes: 150 },
];

/**
 * Calculates the appropriate duration for a party size.
 * 
 * @param partySize - Number of people in the party
 * @param customRules - Optional custom rules (defaults to DEFAULT_DURATION_RULES)
 * @returns Duration in minutes (always a multiple of 15)
 */
export function calculateDurationByPartySize(
  partySize: number,
  customRules?: DurationRule[]
): number {
  const rules = customRules || DEFAULT_DURATION_RULES;
  
  // Find the first rule where partySize <= maxPartySize
  const rule = rules.find((r) => partySize <= r.maxPartySize);
  
  if (!rule) {
    // Fallback to longest duration if no rule matches
    return rules[rules.length - 1].durationMinutes;
  }
  
  // Ensure duration is a multiple of 15
  const duration = rule.durationMinutes;
  return Math.ceil(duration / 15) * 15;
}

/**
 * Gets duration rules for a restaurant (can be customized per restaurant).
 * For now, returns default rules, but can be extended to support per-restaurant configuration.
 */
export function getDurationRules(restaurantId?: string): DurationRule[] {
  // Future: could load from restaurant configuration
  return DEFAULT_DURATION_RULES;
}

