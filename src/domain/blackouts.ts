/**
 * B4 - Blackouts
 * 
 * Per-table maintenance or private event windows that block availability.
 * Blackouts prevent bookings from being created during specified time periods.
 */

import type { ISODateTime, Table } from './types.js';
import { db } from '../store/db.js';
import { toZonedIso } from './gaps.js';

export interface Blackout {
  id: string;
  tableId: string;
  start: ISODateTime;
  end: ISODateTime;
  reason: string; // 'maintenance' | 'private_event' | 'other'
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

/**
 * Checks if a time period overlaps with any blackouts for given tables.
 * 
 * Uses interval overlap detection for half-open intervals [start, end).
 * Two intervals [a, b) and [c, d) overlap if: a < d && b > c
 * 
 * Edge cases handled:
 * - Empty intervals (start == end): Correctly returns false (empty interval doesn't overlap)
 * - Zero-duration blackouts: Correctly detected if they fall within the period
 * 
 * @param tableIds - Array of table IDs to check for blackouts
 * @param start - Start time of the period to check (inclusive)
 * @param end - End time of the period to check (exclusive)
 * @returns true if any blackout overlaps with the given time period
 */
export function hasBlackout(
  tableIds: string[],
  start: ISODateTime,
  end: ISODateTime
): boolean {
  const blackouts = db.getBlackoutsByTables(tableIds);
  
  // Handle edge case: empty period (start == end) doesn't overlap anything
  if (start >= end) {
    return false;
  }
  
  return blackouts.some((blackout) => {
    // Handle edge case: empty blackout (start == end) doesn't block anything
    if (blackout.start >= blackout.end) {
      return false;
    }
    
    // Standard overlap check for half-open intervals [start, end)
    // Two intervals [a, b) and [c, d) overlap if: a < d && b > c
    // This correctly handles all non-empty interval cases
    return blackout.start < end && blackout.end > start;
  });
}

/**
 * Filters gaps to exclude blackout periods.
 */
export function filterGapsByBlackouts(
  gaps: Array<{ start: ISODateTime; end: ISODateTime }>,
  tableIds: string[]
): Array<{ start: ISODateTime; end: ISODateTime }> {
  const blackouts = db.getBlackoutsByTables(tableIds);
  
  if (blackouts.length === 0) {
    return gaps;
  }
  
  const filtered: Array<{ start: ISODateTime; end: ISODateTime }> = [];
  
  for (const gap of gaps) {
    const gapStart = new Date(gap.start).getTime();
    const gapEnd = new Date(gap.end).getTime();
    
    // Find blackouts that overlap with this gap
    const overlappingBlackouts = blackouts.filter((blackout) => {
      const blackoutStart = new Date(blackout.start).getTime();
      const blackoutEnd = new Date(blackout.end).getTime();
      return blackoutStart < gapEnd && blackoutEnd > gapStart;
    });
    
    if (overlappingBlackouts.length === 0) {
      // No blackouts, keep the gap
      filtered.push(gap);
    } else {
      // Split gap around blackouts
      let currentStart = gapStart;
      
      // Sort blackouts by start time
      overlappingBlackouts.sort((a, b) => 
        new Date(a.start).getTime() - new Date(b.start).getTime()
      );
      
      for (const blackout of overlappingBlackouts) {
        const blackoutStart = new Date(blackout.start).getTime();
        const blackoutEnd = new Date(blackout.end).getTime();
        
        // If there's space before the blackout, add it
        if (currentStart < blackoutStart) {
          filtered.push({
            start: new Date(currentStart).toISOString(),
            end: new Date(blackoutStart).toISOString(),
          });
        }
        
        // Move current start to after the blackout
        currentStart = Math.max(currentStart, blackoutEnd);
      }
      
      // If there's space after the last blackout, add it
      if (currentStart < gapEnd) {
        filtered.push({
          start: new Date(currentStart).toISOString(),
          end: new Date(gapEnd).toISOString(),
        });
      }
    }
  }
  
  return filtered;
}

