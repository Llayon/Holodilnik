import type { FridgeAnalysisResult } from "../../shared/types.js";

/**
 * Scan settlement cache (Gauntlet 2, ADR-044/045).
 *
 * Keyed by Platform requestId (`fridge.scan:<uuid>`):
 * - `recall` replays a finished scan without rerunning AI or recharging:
 *   commit-timeout retries land here.
 * - `runExclusive` dedupes concurrent same-key scans (retry storms share one
 *   reserve→AI→commit execution; billing idempotency holds regardless).
 *
 * Memory-only, bounded (200 entries, oldest evicted). A process restart loses
 * replays — but reservations stay idempotent server-side (same requestId
 * returns the same reservation), so the worst case is one repeated AI call,
 * never a double charge.
 */

export interface SettledScan {
  result: FridgeAnalysisResult;
  provider: string;
  modelId: string;
  cached: boolean;
  reservationId: string;
  empty: boolean;
}

const MAX_ENTRIES = 200;

const settled = new Map<string, SettledScan>();
const inFlight = new Map<string, Promise<SettledScan>>();

export function recallSettlement(key: string): SettledScan | undefined {
  return settled.get(key);
}

export function storeSettlement(key: string, scan: SettledScan): void {
  if (settled.size >= MAX_ENTRIES) {
    const first = settled.keys().next().value;
    if (first) settled.delete(first);
  }
  settled.set(key, scan);
}

export function runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const ongoing = inFlight.get(key) as Promise<T> | undefined;
  if (ongoing) return ongoing;
  const p = fn().finally(() => {
    if (inFlight.get(key) === p) inFlight.delete(key);
  });
  inFlight.set(key, p as Promise<SettledScan>);
  return p;
}

/** Test hook: clear both maps. */
export function __clearSettlementForTests(): void {
  settled.clear();
  inFlight.clear();
}
