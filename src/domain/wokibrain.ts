import type { Candidate, Table, Gap } from './types.js';
import { findTableGaps, findComboGaps, filterGapsByDuration, calculateComboCapacity, toZonedIso } from './gaps.js';
import { db } from '../store/db.js';

/**
 * WokiBrain selection strategy:
 * 1. Prefer single tables over combinations
 * 2. Among same kind, prefer earliest start time
 * 3. For ties, prefer minimum waste (smallest capacity that fits)
 * 4. For final ties, sort by table IDs lexicographically
 */
export function findCandidates(
  sectorId: string,
  date: string,
  partySize: number,
  durationMinutes: number,
  serviceWindows: Array<{ start: string; end: string }>,
  restaurantTimezone: string,
  requestedWindowStart?: string,
  requestedWindowEnd?: string,
  limit: number = 10
): Candidate[] {
  // Get tables for the sector - this always returns an array (never null/undefined)
  const tables = db.getTablesBySector(sectorId);
  
  // Handle edge case: no tables found in sector
  // This prevents runtime errors when trying to iterate over tables or generate combinations
  // Return empty array early to avoid unnecessary processing and potential exceptions
  if (!tables || tables.length === 0) {
    return [];
  }
  
  const candidates: Candidate[] = [];

  // Filter service windows if requested window is provided
  let activeWindows = serviceWindows || [];
  const hasRequestedWindow = requestedWindowStart && requestedWindowEnd;
  const requestedStartIso = hasRequestedWindow
    ? toZonedIso(date, requestedWindowStart!, restaurantTimezone)
    : null;
  const requestedEndIso = hasRequestedWindow
    ? toZonedIso(date, requestedWindowEnd!, restaurantTimezone)
    : null;
  const requestedStartTs = requestedStartIso ? new Date(requestedStartIso).getTime() : null;
  const requestedEndTs = requestedEndIso ? new Date(requestedEndIso).getTime() : null;

  if (requestedWindowStart && requestedWindowEnd) {
    // Check if requested window intersects with any service window
    activeWindows = activeWindows.filter((window) => {
      const windowStart = toZonedIso(date, window.start, restaurantTimezone);
      const windowEnd = toZonedIso(date, window.end, restaurantTimezone);
      return requestedStartIso! < windowEnd && requestedEndIso! > windowStart;
    });

    if (activeWindows.length === 0) {
      return []; // No intersection with service windows
    }
  }

  // Find single table candidates
  for (const table of tables) {
    if (partySize < table.minSize || partySize > table.maxSize) {
      continue; // Party doesn't fit
    }

    const gaps = findTableGaps(table.id, date, activeWindows, restaurantTimezone);
    const validGaps = filterGapsByDuration(gaps, durationMinutes);

    // Filter by requested window if provided
    let filteredGaps = validGaps;
    if (requestedStartTs !== null && requestedEndTs !== null) {
      filteredGaps = validGaps.filter((gap) => {
        const gapStart = new Date(gap.start).getTime();
        const gapEnd = new Date(gap.end).getTime();
        return gapStart >= requestedStartTs && gapEnd <= requestedEndTs;
      });
    }

    for (const gap of filteredGaps) {
      candidates.push({
        kind: 'single',
        tableIds: [table.id],
        start: gap.start,
        end: gap.end,
        minCapacity: table.minSize,
        maxCapacity: table.maxSize,
      });
    }
  }

  // Find combo candidates (all combinations of 2 or more tables)
  const tableIds = tables.map((t) => t.id);
  const combos = generateCombinations(tableIds, 2); // 2..N combos

  for (const comboTableIds of combos) {
    const comboTables = comboTableIds
      .map((id) => tables.find((t) => t.id === id))
      .filter((t): t is Table => t !== undefined);

    const capacity = calculateComboCapacity(comboTables);
    if (partySize < capacity.minCapacity || partySize > capacity.maxCapacity) {
      continue; // Party doesn't fit
    }

    const gaps = findComboGaps(comboTableIds, date, activeWindows, restaurantTimezone);
    const validGaps = filterGapsByDuration(gaps, durationMinutes);

    let filteredGaps = validGaps;
    if (requestedStartTs !== null && requestedEndTs !== null) {
      filteredGaps = validGaps.filter((gap) => {
        const gapStart = new Date(gap.start).getTime();
        const gapEnd = new Date(gap.end).getTime();
        return gapStart >= requestedStartTs && gapEnd <= requestedEndTs;
      });
    }

    for (const gap of filteredGaps) {
      candidates.push({
        kind: 'combo',
        tableIds: comboTableIds,
        start: gap.start,
        end: gap.end,
        minCapacity: capacity.minCapacity,
        maxCapacity: capacity.maxCapacity,
      });
    }
  }

  // Calculate score and rationale for each candidate
  // Score is used for tie-breaking but primary sorting is done by the strategy below
  candidates.forEach((candidate) => {
    const waste = candidate.maxCapacity! - partySize;
    const startTime = new Date(candidate.start).getTime();
    
    // Scoring system (lower is better):
    // - Base: 0 for single tables, 1000 for combos (singles prioritized)
    // - Waste: 10 points per wasted seat (encourages efficient use)
    // - Time: Modulo of timestamp seconds (deterministic tiebreaker)
    const baseScore = candidate.kind === 'single' ? 0 : 1000; // Singles get priority
    const wasteScore = waste * 10; // Waste penalty
    const timeScore = Math.floor(startTime / 1000) % 10000; // Time-based tiebreaker
    
    candidate.score = baseScore + wasteScore + timeScore;
    
    // Generate human-readable rationale explaining why this candidate was selected
    const reasons: string[] = [];
    if (candidate.kind === 'single') {
      reasons.push('single table');
    } else {
      reasons.push(`${candidate.tableIds.length}-table combo`);
    }
    reasons.push(`capacity: ${candidate.minCapacity}-${candidate.maxCapacity}`);
    if (waste === 0) {
      reasons.push('perfect fit');
    } else {
      reasons.push(`${waste} seat${waste > 1 ? 's' : ''} spare`);
    }
    candidate.rationale = reasons.join(', ');
  });

  // Sort candidates according to WokiBrain strategy
  candidates.sort((a, b) => {
    // 1. Prefer single over combo
    if (a.kind !== b.kind) {
      return a.kind === 'single' ? -1 : 1;
    }

    // 2. Prefer earliest start time
    const timeDiff = a.start.localeCompare(b.start);
    if (timeDiff !== 0) return timeDiff;

    // 3. Prefer minimum waste (smallest maxCapacity that fits)
    const wasteA = a.maxCapacity! - partySize;
    const wasteB = b.maxCapacity! - partySize;
    if (wasteA !== wasteB) return wasteA - wasteB;

    // 4. Deterministic ordering by table IDs
    const idsA = a.tableIds.sort().join(',');
    const idsB = b.tableIds.sort().join(',');
    return idsA.localeCompare(idsB);
  });

  return candidates.slice(0, limit);
}

/**
 * Generates all combinations of size k from an array.
 * 
 * Uses recursive backtracking to generate all combinations:
 * - For each size from minSize to array length
 * - Recursively build combinations by either including or excluding each element
 * - When target size is reached, add the combination to results
 * 
 * Example: generateCombinations([1,2,3], 2) returns:
 * [[1,2], [1,3], [2,3], [1,2,3]]
 * 
 * Time complexity: O(2^n) where n is array length
 * This is acceptable for typical restaurant scenarios (usually < 20 tables per sector)
 */
function generateCombinations<T>(arr: T[], minSize: number): T[][] {
  if (minSize <= 0 || minSize > arr.length) return [];

  const combinations: T[][] = [];

  /**
   * Recursive helper to build combinations
   * @param start - Index to start from (prevents duplicates)
   * @param targetSize - Desired combination size
   * @param combo - Current combination being built
   */
  function combine(start: number, targetSize: number, combo: T[]) {
    // Base case: combination is complete
    if (combo.length === targetSize) {
      combinations.push([...combo]); // Copy to avoid mutation
      return;
    }

    // Try each remaining element
    for (let i = start; i < arr.length; i++) {
      combo.push(arr[i]);
      combine(i + 1, targetSize, combo); // Recurse with next starting index
      combo.pop(); // Backtrack
    }
  }

  // Generate combinations of all sizes from minSize to array length
  for (let size = minSize; size <= arr.length; size++) {
    combine(0, size, []);
  }

  return combinations;
}

/**
 * Selects the best candidate using WokiBrain strategy.
 * Returns the first candidate (already sorted) or null if none available.
 */
export function selectBestCandidate(
  sectorId: string,
  date: string,
  partySize: number,
  durationMinutes: number,
  serviceWindows: Array<{ start: string; end: string }>,
  restaurantTimezone: string,
  requestedWindowStart?: string,
  requestedWindowEnd?: string
): Candidate | null {
  const candidates = findCandidates(
    sectorId,
    date,
    partySize,
    durationMinutes,
    serviceWindows,
    restaurantTimezone,
    requestedWindowStart,
    requestedWindowEnd,
    1
  );

  return candidates.length > 0 ? candidates[0] : null;
}

