import type { Booking, Gap, Table, ISODateTime } from './types.js';
import { db } from '../store/db.js';
import { filterGapsByBlackouts } from './blackouts.js';

/**
 * Calculates the capacity range for a combination of tables.
 * Uses simple sum approach: min = sum of all minSizes, max = sum of all maxSizes.
 */
export function calculateComboCapacity(tables: Table[]): {
  minCapacity: number;
  maxCapacity: number;
} {
  const minCapacity = tables.reduce((sum, table) => sum + table.minSize, 0);
  const maxCapacity = tables.reduce((sum, table) => sum + table.maxSize, 0);
  return { minCapacity, maxCapacity };
}

/**
 * Finds gaps in a single table's availability for a given day.
 * Gaps are intervals where the table is free.
 */
export function findTableGaps(
  tableId: string,
  date: string,
  serviceWindows: Array<{ start: string; end: string }>,
  restaurantTimezone: string
): Gap[] {
  const bookings = db.getBookingsByTablesAndDate([tableId], date);
  const gaps: Gap[] = [];

  // If no service windows, treat full day as available
  if (!serviceWindows || serviceWindows.length === 0) {
    const dayStart = toZonedIso(date, '00:00', restaurantTimezone);
    const dayEnd = toZonedIso(date, '23:59', restaurantTimezone);
    return findGapsInWindow(bookings, dayStart, dayEnd);
  }

  // Find gaps within each service window
  for (const window of serviceWindows) {
    const windowStart = toZonedIso(date, window.start, restaurantTimezone);
    const windowEnd = toZonedIso(date, window.end, restaurantTimezone);
    const windowGaps = findGapsInWindow(bookings, windowStart, windowEnd);
    gaps.push(...windowGaps);
  }

  // B4: Filter out blackout periods
  const filteredGaps = filterGapsByBlackouts(gaps, [tableId]);
  return filteredGaps;
}

/**
 * Finds gaps within a specific time window, considering existing bookings.
 * 
 * Algorithm:
 * 1. Filter bookings that overlap with the window (using interval overlap: a < d && b > c)
 * 2. Sort bookings by start time
 * 3. Iterate through bookings, tracking the current "free" time
 * 4. For each booking, if there's a gap before it, add it to results
 * 5. Update current time to the end of the booking (or keep it if already past)
 * 6. After all bookings, add any remaining gap until window end
 * 
 * This efficiently finds all free time slots within a window, handling overlapping
 * bookings correctly by tracking the maximum end time seen so far.
 */
function findGapsInWindow(
  bookings: Booking[],
  windowStart: ISODateTime,
  windowEnd: ISODateTime
): Gap[] {
  const gaps: Gap[] = [];

  const winStartTs = new Date(windowStart).getTime();
  const winEndTs = new Date(windowEnd).getTime();

  // Filter bookings that overlap with the window using interval overlap detection
  // Two intervals [a, b) and [c, d) overlap if: a < d && b > c
  const relevantBookings = bookings
    .filter((b) => {
      const startTs = new Date(b.start).getTime();
      const endTs = new Date(b.end).getTime();
      return startTs < winEndTs && endTs > winStartTs;
    })
    .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());

  // Track the current "free" time as we iterate through bookings
  let currentTimeTs = winStartTs;

  for (const booking of relevantBookings) {
    const bookingStartTs = new Date(booking.start).getTime();
    const bookingEndTs = new Date(booking.end).getTime();

    // If there's a gap before this booking, add it
    if (currentTimeTs < bookingStartTs) {
      gaps.push({
        start: new Date(currentTimeTs).toISOString(),
        end: new Date(bookingStartTs).toISOString(),
      });
    }
    // Advance current time to the end of this booking (or keep it if already past)
    // This handles overlapping bookings correctly
    currentTimeTs = bookingEndTs > currentTimeTs ? bookingEndTs : currentTimeTs;
  }

  // Add any remaining gap after the last booking until window end
  if (currentTimeTs < winEndTs) {
    gaps.push({
      start: new Date(currentTimeTs).toISOString(),
      end: new Date(winEndTs).toISOString(),
    });
  }

  return gaps;
}

export function toZonedIso(date: string, time: string, timeZone: string): string {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const utcTs = Date.UTC(year, month - 1, day, hour, minute);
  const offsetMinutes = getTimeZoneOffset(new Date(utcTs), timeZone);
  return new Date(utcTs - offsetMinutes * 60 * 1000).toISOString();
}

function getTimeZoneOffset(date: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  const [
    { value: month },
    { value: day },
    { value: year },
    { value: hour },
    { value: minute },
    { value: second },
  ] = dtf.formatToParts(date).filter((part) => part.type !== 'literal');

  const asUTC = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second)
  );

  return (asUTC - date.getTime()) / (60 * 1000);
}

/**
 * Finds gaps where a combination of tables are all simultaneously free.
 * Returns the intersection of gaps from all tables in the combination.
 */
export function findComboGaps(
  tableIds: string[],
  date: string,
  serviceWindows: Array<{ start: string; end: string }>,
  restaurantTimezone: string
): Gap[] {
  if (tableIds.length === 0) return [];
  if (tableIds.length === 1) {
    return findTableGaps(tableIds[0], date, serviceWindows, restaurantTimezone);
  }

  // Get gaps for each table
  const tableGaps = tableIds.map((tableId) =>
    findTableGaps(tableId, date, serviceWindows, restaurantTimezone)
  );

  // Intersect all gap sets
  let intersection = tableGaps[0];
  for (let i = 1; i < tableGaps.length; i++) {
    intersection = intersectGaps(intersection, tableGaps[i]);
  }

  // B4: Filter out blackout periods for all tables in combo
  const filteredGaps = filterGapsByBlackouts(intersection, tableIds);
  return filteredGaps;
}

/**
 * Intersects two sets of gaps, finding intervals where both are free.
 * 
 * Uses a two-pointer merge algorithm:
 * 1. Both gap arrays are assumed to be sorted by start time
 * 2. Use two pointers (i, j) to traverse both arrays simultaneously
 * 3. For each pair of gaps, compute their overlap (if any)
 * 4. The overlap is [max(start1, start2), min(end1, end2))
 * 5. Advance the pointer whose gap ends earlier
 * 
 * This efficiently finds all time periods where both tables are simultaneously free,
 * which is required for combo bookings.
 */
function intersectGaps(gaps1: Gap[], gaps2: Gap[]): Gap[] {
  const result: Gap[] = [];
  let i = 0;
  let j = 0;

  while (i < gaps1.length && j < gaps2.length) {
    const gap1 = gaps1[i];
    const gap2 = gaps2[j];

    // Compute overlap: [max(start1, start2), min(end1, end2))
    const overlapStart = gap1.start > gap2.start ? gap1.start : gap2.start;
    const overlapEnd = gap1.end < gap2.end ? gap1.end : gap2.end;

    // Only add if overlap is non-empty (overlapStart < overlapEnd)
    if (overlapStart < overlapEnd) {
      result.push({
        start: overlapStart,
        end: overlapEnd,
      });
    }

    // Advance the pointer whose gap ends earlier
    // This ensures we don't miss any overlaps
    if (gap1.end < gap2.end) {
      i++;
    } else {
      j++;
    }
  }

  return result;
}

/**
 * Filters gaps to only include those that fit the requested duration.
 * Also rounds to 15-minute grid boundaries and generates all valid start times.
 * 
 * Algorithm:
 * 1. Round gap start UP to next 15-minute boundary (can't start in the middle of a slot)
 * 2. Round gap end DOWN to previous 15-minute boundary (can't end in the middle of a slot)
 * 3. If rounded gap is long enough for the duration, generate all possible start times
 * 4. For each valid start time, create a candidate gap of exactly the requested duration
 * 5. Advance by 15 minutes to find the next possible start time
 * 
 * Example: If gap is [10:07, 11:23) and duration is 60 minutes:
 * - Rounded: [10:15, 11:15) (rounded up start, rounded down end)
 * - Valid starts: 10:15 (ends 11:15), 10:30 (ends 11:30 - but this exceeds rounded end)
 * - Result: [10:15, 11:15)
 */
export function filterGapsByDuration(
  gaps: Gap[],
  durationMinutes: number,
  slotMinutes: number = 15
): Gap[] {
  const validGaps: Gap[] = [];

  for (const gap of gaps) {
    const gapStart = new Date(gap.start);
    const gapEnd = new Date(gap.end);

    // Round start UP to next slot boundary (bookings must start on grid)
    const roundedStart = roundToSlot(gapStart, slotMinutes, 'up');
    // Round end DOWN to previous slot boundary (bookings must end on grid)
    const roundedEnd = roundToSlot(gapEnd, slotMinutes, 'down');

    // Calculate available duration after rounding
    const availableMinutes =
      (roundedEnd.getTime() - roundedStart.getTime()) / (1000 * 60);

    // Only process if rounded gap is long enough
    if (availableMinutes >= durationMinutes) {
      // Generate all valid start times within this gap
      // Each start time must allow for a booking of exactly durationMinutes
      let currentStart = roundedStart;
      while (currentStart.getTime() + durationMinutes * 60 * 1000 <= roundedEnd.getTime()) {
        const currentEnd = new Date(currentStart.getTime() + durationMinutes * 60 * 1000);
        validGaps.push({
          start: currentStart.toISOString(),
          end: currentEnd.toISOString(),
        });
        // Move to next 15-minute slot to find next possible start
        currentStart = new Date(currentStart.getTime() + slotMinutes * 60 * 1000);
      }
    }
  }

  return validGaps;
}

/**
 * Rounds a date to the nearest slot boundary.
 */
function roundToSlot(
  date: Date,
  slotMinutes: number,
  direction: 'up' | 'down'
): Date {
  const minutes = date.getMinutes();
  const remainder = minutes % slotMinutes;

  if (remainder === 0) return new Date(date);

  const rounded = new Date(date);
  if (direction === 'up') {
    rounded.setMinutes(minutes + (slotMinutes - remainder));
    rounded.setSeconds(0);
    rounded.setMilliseconds(0);
  } else {
    rounded.setMinutes(minutes - remainder);
    rounded.setSeconds(0);
    rounded.setMilliseconds(0);
  }

  return rounded;
}

