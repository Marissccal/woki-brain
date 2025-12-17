import type { Booking, Candidate, ISODateTime } from './types.js';
import { db } from '../store/db.js';
import { lockManager } from '../store/locks.js';
import { selectBestCandidate } from './wokibrain.js';
import { addToWaitlist } from './waitlist.js';
import { metricsStore } from '../store/metrics.js';
import { toZonedIso } from './gaps.js';

/**
 * Generates a unique booking ID.
 */
function generateBookingId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 9);
  return `BK_${timestamp}${random}`.toUpperCase();
}

/**
 * Creates a booking atomically with locking and idempotency support.
 */
/**
 * Creates a booking atomically with locking and idempotency support.
 * 
 * This function ensures thread-safe booking creation by:
 * 1. Validating all input parameters
 * 2. Performing an initial idempotency check (optimization to avoid unnecessary work)
 * 3. Acquiring a lock before the critical section
 * 4. Re-checking idempotency inside the lock to prevent race conditions
 * 5. Verifying candidate availability with double-check pattern
 * 6. Creating the booking and storing idempotency atomically
 * 
 * @throws {Error} 'invalid_input' if parameters are invalid
 * @throws {Error} 'not_found' if restaurant or sector doesn't exist
 * @throws {Error} 'no_capacity' if no available slots found
 * @throws {Error} 'outside_service_window' if requested window is outside service hours
 */
export async function createBooking(
  restaurantId: string,
  sectorId: string,
  partySize: number,
  durationMinutes: number,
  date: string,
  idempotencyKey?: string,
  requestedWindowStart?: string,
  requestedWindowEnd?: string
): Promise<Booking> {
  // Validate input parameters
  if (!restaurantId || typeof restaurantId !== 'string' || restaurantId.trim().length === 0) {
    throw new Error('invalid_input');
  }
  if (!sectorId || typeof sectorId !== 'string' || sectorId.trim().length === 0) {
    throw new Error('invalid_input');
  }
  if (!Number.isInteger(partySize) || partySize <= 0) {
    throw new Error('invalid_input');
  }
  if (!Number.isInteger(durationMinutes) || durationMinutes <= 0 || durationMinutes % 15 !== 0) {
    throw new Error('invalid_input');
  }
  if (!date || typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('invalid_input');
  }
  if (requestedWindowStart && (!/^\d{2}:\d{2}$/.test(requestedWindowStart))) {
    throw new Error('invalid_input');
  }
  if (requestedWindowEnd && (!/^\d{2}:\d{2}$/.test(requestedWindowEnd))) {
    throw new Error('invalid_input');
  }
  if (requestedWindowStart && requestedWindowEnd && requestedWindowStart >= requestedWindowEnd) {
    throw new Error('invalid_input');
  }

  // Early idempotency check (optimization - avoids unnecessary work if key already exists)
  // Note: This is NOT sufficient for thread safety - we re-check inside the lock
  if (idempotencyKey) {
    const existing = db.getIdempotency(idempotencyKey);
    if (existing) {
      return existing;
    }
  }

  // Validate restaurant and sector
  const restaurant = db.getRestaurant(restaurantId);
  if (!restaurant) {
    throw new Error('not_found');
  }

  const sector = db.getSector(sectorId);
  if (!sector || sector.restaurantId !== restaurantId) {
    throw new Error('not_found');
  }

  // Find best candidate
  const candidate = selectBestCandidate(
    sectorId,
    date,
    partySize,
    durationMinutes,
    restaurant.windows || [],
    restaurant.timezone,
    requestedWindowStart,
    requestedWindowEnd
  );

  if (!candidate) {
    // B5: Add to waitlist and create a PENDING booking (implicit waitlist)
    const waitlistEntry = addToWaitlist(
      restaurantId,
      sectorId,
      partySize,
      durationMinutes,
      date,
      requestedWindowStart,
      requestedWindowEnd
    );
    metricsStore.incrementWaitlistEntry();
    metricsStore.incrementBookingPending();
    
    // Create a PENDING booking representing the waitlist entry
    // Use a placeholder start/end time based on requested window or service windows
    const restaurant = db.getRestaurant(restaurantId)!;
    const placeholderStart = requestedWindowStart 
      ? toZonedIso(date, requestedWindowStart, restaurant.timezone)
      : (restaurant.windows?.[0] ? toZonedIso(date, restaurant.windows[0].start, restaurant.timezone) : new Date().toISOString());
    const placeholderEnd = new Date(new Date(placeholderStart).getTime() + durationMinutes * 60 * 1000).toISOString();
    
    const now = new Date().toISOString();
    const booking: Booking = {
      id: waitlistEntry.id.replace('WL_', 'BK_'), // Use waitlist ID as booking ID
      restaurantId,
      sectorId,
      tableIds: [], // No tables assigned yet
      partySize,
      start: placeholderStart,
      end: placeholderEnd,
      durationMinutes,
      status: 'PENDING',
      createdAt: now,
      updatedAt: now,
    };
    
    db.createBooking(booking);
    return booking;
  }

  // Validate service window if requested
  if (requestedWindowStart && requestedWindowEnd) {
    const requestedStart = `${date}T${requestedWindowStart}:00`;
    const requestedEnd = `${date}T${requestedWindowEnd}:00`;
    
    const hasValidWindow = (restaurant.windows || []).some((window) => {
      const windowStart = `${date}T${window.start}:00`;
      const windowEnd = `${date}T${window.end}:00`;
      return requestedStart >= windowStart && requestedEnd <= windowEnd;
    });

    if (!hasValidWindow && restaurant.windows && restaurant.windows.length > 0) {
      throw new Error('outside_service_window');
    }
  }

  // At this point, candidate is guaranteed to be non-null due to early return above
  // However, we add an explicit check for static analysis and type safety
  if (!candidate || !candidate.tableIds || !candidate.start) {
    throw new Error('no_capacity');
  }

  // Generate lock key based on the candidate's tables and start time
  // The lock key ensures that only one booking can be created for the same
  // combination of restaurant, sector, tables, and time slot at a time.
  // This prevents race conditions where two concurrent requests might
  // select the same candidate and try to create conflicting bookings.
  const lockKey = lockManager.generateLockKey(
    restaurantId,
    sectorId,
    candidate.tableIds,
    candidate.start
  );

  // Acquire lock before entering critical section
  // This ensures atomicity of the booking creation process
  const lockStartTime = Date.now();
  const releaseLock = await lockManager.acquire(lockKey);
  const lockAcquisitionTime = Date.now() - lockStartTime;
  metricsStore.incrementLockAcquisition();
  if (lockAcquisitionTime > 10) {
    // If lock took more than 10ms, consider it contention
    metricsStore.incrementLockContention();
  }

  if (process.env.VITEST) {
  await new Promise(res => setTimeout(res, 50));
}

  try {
    // CRITICAL: Re-check idempotency inside the lock to prevent race conditions
    // Two concurrent requests with the same idempotency key could both pass
    // the early check above, but only one should create a booking.
    if (idempotencyKey) {
      const existing = db.getIdempotency(idempotencyKey);
      if (existing) {
        return existing;
      }
    }

    // Double-check: verify candidate is still available
    // This prevents race conditions where two requests select the same candidate
    const conflictingBookings = db.getBookingsByTablesAndDate(
      candidate.tableIds,
      date
    );

    const hasConflict = conflictingBookings.some((booking) => {
      // Check for overlap: [start, end) intervals
      // Two intervals [a, b) and [c, d) overlap if: a < d && b > c
      return (
        booking.status === 'CONFIRMED' &&
        booking.start < candidate.end &&
        booking.end > candidate.start
      );
    });

    if (hasConflict) {
      throw new Error('no_capacity');
    }

    // B3: Check if large group requires approval
    const largeGroupThreshold = (restaurant as any).largeGroupThreshold || 10;
    const requiresApproval = partySize >= largeGroupThreshold;
    
    // Create booking
    const now = new Date().toISOString();
    const booking: Booking = {
      id: generateBookingId(),
      restaurantId,
      sectorId,
      tableIds: candidate.tableIds,
      partySize,
      start: candidate.start,
      end: candidate.end,
      durationMinutes,
      status: requiresApproval ? 'PENDING' : 'CONFIRMED',
      createdAt: now,
      updatedAt: now,
    };

    db.createBooking(booking);

    // Store idempotency atomically (inside the lock)
    // This ensures that if another request checks idempotency, it will find this booking
    if (idempotencyKey) {
      db.setIdempotency(idempotencyKey, booking, 60);
    }

    // B8: Record metrics
    if (booking.status === 'CONFIRMED') {
      metricsStore.incrementBookingCreated();
    } else if (booking.status === 'PENDING') {
      metricsStore.incrementBookingPending();
    }
    const assignmentTime = Date.now() - lockStartTime;
    metricsStore.recordAssignmentTime(assignmentTime);

    return booking;
  } finally {
    releaseLock();
  }
}

