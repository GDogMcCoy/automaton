/**
 * Conway Credits Management
 *
 * Monitors the automaton's compute credit balance and triggers
 * survival mode transitions.
 */

import type {
  ConwayClient,
  FinancialState,
  SurvivalTier,
  AutomatonDatabase,
} from "../types.js";
import { SURVIVAL_THRESHOLDS } from "../types.js";

/**
 * Check the current financial state of the automaton.
 */
export async function checkFinancialState(
  conway: ConwayClient,
  usdcBalance: number,
): Promise<FinancialState> {
  const creditsCents = await conway.getCreditsBalance();

  return {
    creditsCents,
    usdcBalance,
    lastChecked: new Date().toISOString(),
  };
}

/**
 * Determine the survival tier based on current credits.
 */
export function getSurvivalTier(creditsCents: number): SurvivalTier {
  if (creditsCents > SURVIVAL_THRESHOLDS.normal) return "normal";
  if (creditsCents > SURVIVAL_THRESHOLDS.low_compute)
    return "low_compute";
  if (creditsCents > SURVIVAL_THRESHOLDS.dead) return "critical";
  return "dead";
}

/**
 * Determine the survival tier considering both Conway credits AND on-chain
 * USDC balance. This is the sovereignty-aware version: even if Conway credits
 * are zero, the automaton can survive if it has USDC to pay providers directly.
 *
 * USDC is converted to equivalent "cents" at 1 USDC = 100 cents.
 * A 20% haircut is applied since direct provider payments may cost more
 * than subsidized Conway credits.
 */
export function getSovereignSurvivalTier(
  creditsCents: number,
  usdcBalance: number,
): SurvivalTier {
  // Conway credits tier (the normal path)
  const creditsTier = getSurvivalTier(creditsCents);

  // If credits alone are fine, no need to consider USDC
  if (creditsTier === "normal") return "normal";

  // Convert USDC to effective cents (1 USDC = 100 cents, 20% haircut)
  const usdcCents = Math.floor(usdcBalance * 100 * 0.8);
  const combinedCents = creditsCents + usdcCents;

  // Reassess with combined funds
  const combinedTier = getSurvivalTier(combinedCents);

  // If USDC helps, return the better tier
  if (tierPriority(combinedTier) < tierPriority(creditsTier)) {
    return combinedTier;
  }

  return creditsTier;
}

/** Lower number = healthier tier (for comparison) */
function tierPriority(tier: SurvivalTier): number {
  switch (tier) {
    case "normal": return 0;
    case "low_compute": return 1;
    case "critical": return 2;
    case "dead": return 3;
  }
}

/**
 * Format a credit amount for display.
 */
export function formatCredits(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Log a credit check to the database.
 */
export function logCreditCheck(
  db: AutomatonDatabase,
  state: FinancialState,
): void {
  db.insertTransaction({
    id: generateId(),
    type: "credit_check",
    amountCents: state.creditsCents,
    description: `Balance check: ${formatCredits(state.creditsCents)} credits, ${state.usdcBalance.toFixed(4)} USDC`,
    timestamp: state.lastChecked,
  });
}

/** Monotonic counter for ID uniqueness within a single process. */
let idCounter = 0;

/**
 * Generate a time-sortable unique ID.
 * Format: <ms-timestamp-base36>-<random-6chars>-<counter-base36>
 * This is synchronous (no async import needed) and safe for SQLite.
 */
export function generateId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  idCounter++;
  return `${timestamp}-${random}-${idCounter.toString(36)}`;
}
