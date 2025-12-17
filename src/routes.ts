import * as express from 'express';
import { type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import pino from 'pino';
import { db } from './store/db.js';
import { findCandidates } from './domain/wokibrain.js';
import { toZonedIso } from './domain/gaps.js';
import { createBooking } from './domain/booking-service.js';
import { calculateDurationByPartySize, getDurationRules } from './domain/duration-rules.js';
import type { Blackout } from './domain/blackouts.js';
import { tryPromoteWaitlist, cleanupExpiredWaitlist } from './domain/waitlist.js';
import { metricsStore } from './store/metrics.js';

// Create a simple, readable logger for tests that doesn't use thread streams
function createTestLogger() {
  const formatTime = () => {
    const now = new Date();
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    const ms = String(now.getMilliseconds()).padStart(3, '0');
    return `${hours}:${minutes}:${seconds}.${ms}`;
  };

  const formatObj = (obj: any) => {
    const { requestId, error, message, op, outcome, sectorId, partySize, duration, durationMs, bookingId, blackoutId, ...rest } = obj;
    const parts: string[] = [];
    
    // Operation name in bold
    if (op) parts.push(`\x1b[1m${op}\x1b[0m`);
    
    // Outcome with color
    if (outcome) {
      const color = outcome === 'success' ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
      parts.push(color);
    }
    
    // Error message with better formatting
    if (error) {
      // Map error codes to human-readable messages
      const errorMessages: Record<string, string> = {
        'outside_service_window': '\x1b[33m⚠\x1b[0m \x1b[90m(validation: outside service hours)\x1b[0m',
        'no_capacity': '\x1b[33m⚠\x1b[0m \x1b[90m(validation: no capacity available)\x1b[0m',
        'not_found': '\x1b[33m⚠\x1b[0m \x1b[90m(validation: resource not found)\x1b[0m',
        'invalid_input': '\x1b[33m⚠\x1b[0m \x1b[90m(validation: invalid input)\x1b[0m',
      };
      const errorMsg = errorMessages[error] || `\x1b[31m${error}\x1b[0m`;
      parts.push(errorMsg);
    }
    
    // Key fields in a readable format
    const keyFields: string[] = [];
    if (sectorId) keyFields.push(`sector: \x1b[36m${sectorId}\x1b[0m`);
    if (partySize) keyFields.push(`party: \x1b[36m${partySize}\x1b[0m`);
    if (duration) keyFields.push(`duration: \x1b[36m${duration}min\x1b[0m`);
    if (durationMs !== undefined) keyFields.push(`\x1b[90m(${durationMs}ms)\x1b[0m`);
    if (bookingId) keyFields.push(`booking: \x1b[36m${bookingId}\x1b[0m`);
    if (blackoutId) keyFields.push(`blackout: \x1b[36m${blackoutId}\x1b[0m`);
    
    if (keyFields.length > 0) {
      parts.push(keyFields.join(' '));
    }
    
    // Other fields
    const otherFields = Object.entries(rest)
      .filter(([k, v]) => v !== undefined && v !== null && k !== 'message')
      .map(([k, v]) => `\x1b[90m${k}:\x1b[0m \x1b[37m${v}\x1b[0m`)
      .join(' ');
    if (otherFields) parts.push(otherFields);
    
    return parts.join(' ');
  };

  return {
    info: (obj: any) => {
      const time = formatTime();
      const level = '\x1b[36mINFO\x1b[0m';
      const { requestId } = obj;
      const formatted = formatObj(obj);
      const reqPart = requestId ? `\x1b[90m(${requestId})\x1b[0m` : '';
      console.log(`\x1b[90m[${time}]\x1b[0m ${level} ${reqPart} ${formatted}`);
    },
    warn: (obj: any) => {
      const time = formatTime();
      const level = '\x1b[33mVALIDATION (expected)\x1b[0m'; // Expected validation, not an error
      const { requestId } = obj;
      const formatted = formatObj(obj);
      const reqPart = requestId ? `\x1b[90m(${requestId})\x1b[0m` : '';
      console.log(`\x1b[90m[${time}]\x1b[0m ${level} ${reqPart} ${formatted}`);
    },
    error: (obj: any) => {
      const time = formatTime();
      const level = '\x1b[31mERROR\x1b[0m';
      const { requestId } = obj;
      const formatted = formatObj(obj);
      const reqPart = requestId ? `\x1b[90m(${requestId})\x1b[0m` : '';
      console.log(`\x1b[90m[${time}]\x1b[0m ${level} ${reqPart} ${formatted}`);
    },
  } as any;
}

// Use simple logger in test environment to avoid thread stream issues with Vitest
const logger = process.env.VITEST || process.env.NODE_ENV === 'test'
  ? createTestLogger()
  : pino({ transport: { target: 'pino-pretty' } });

const router = express.Router();

function assertWindowWithinService(
  date: string,
  timezone: string,
  requestedStart?: string,
  requestedEnd?: string,
  windows?: Array<{ start: string; end: string }>
) {
  if (!requestedStart || !requestedEnd) return;
  if (!windows || windows.length === 0) return;

  const reqStart = toZonedIso(date, requestedStart, timezone);
  const reqEnd = toZonedIso(date, requestedEnd, timezone);

  const hasOverlap = windows.some((w) => {
    const winStart = toZonedIso(date, w.start, timezone);
    const winEnd = toZonedIso(date, w.end, timezone);
    return reqStart < winEnd && reqEnd > winStart;
  });

  if (!hasOverlap) {
    const err = new Error('outside_service_window');
    throw err;
  }
}

// Request ID middleware
router.use((req: Request, res: Response, next: NextFunction) => {
  (req as any).requestId = `req_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  next();
});

// Validation schemas
const discoverSchema = z.object({
  restaurantId: z.string().min(1),
  sectorId: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  partySize: z.coerce.number().int().positive(),
  duration: z.coerce.number().int().positive().multipleOf(15).optional(), // B1: Optional, auto-calculated if not provided
  windowStart: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  windowEnd: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  limit: z.coerce.number().int().positive().max(100).optional().default(10),
});

const createBookingSchema = z.object({
  restaurantId: z.string().min(1),
  sectorId: z.string().min(1),
  partySize: z.number().int().positive(),
  durationMinutes: z.number().int().positive().multipleOf(15).optional(), // B1: Optional, auto-calculated if not provided
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  windowStart: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  windowEnd: z.string().regex(/^\d{2}:\d{2}$/).optional(),
});

const listBookingsSchema = z.object({
  restaurantId: z.string().min(1),
  sectorId: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

// Error handler
function handleError(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
) {
  const requestId = (req as any).requestId;
  const errorName = err.message;

  // Validation errors (4xx) are expected business logic errors, log as warn
  // System errors (5xx) are unexpected, log as error
  const isValidationError = ['not_found', 'no_capacity', 'outside_service_window', 'invalid_input'].includes(errorName);
  
  if (isValidationError) {
    logger.warn({
      requestId,
      error: errorName,
      message: err.message,
    });
  } else {
    logger.error({
      requestId,
      error: errorName,
      message: err.message,
    });
  }

  if (errorName === 'not_found') {
    return res.status(404).json({
      error: 'not_found',
      detail: 'Restaurant or sector not found',
    });
  }

  if (errorName === 'no_capacity') {
    return res.status(409).json({
      error: 'no_capacity',
      detail: 'No single or combo gap fits duration within window',
    });
  }

  if (errorName === 'outside_service_window') {
    return res.status(422).json({
      error: 'outside_service_window',
      detail: 'Window does not intersect service hours',
    });
  }

  if (errorName === 'invalid_input') {
    return res.status(400).json({
      error: 'invalid_input',
      detail: err.message,
    });
  }

  res.status(500).json({
    error: 'internal_error',
    detail: 'An unexpected error occurred',
  });
}

/**
 * GET /woki/discover
 * Discover available seating candidates
 */
router.get('/woki/discover', async (req: Request, res: Response, next: NextFunction) => {
  const requestId = (req as any).requestId;
  const startTime = Date.now();

  try {
    const params = discoverSchema.parse(req.query);

    // Validate restaurant and sector
    const restaurant = db.getRestaurant(params.restaurantId);
    if (!restaurant) {
      throw new Error('not_found');
    }

    const sector = db.getSector(params.sectorId);
    if (!sector || sector.restaurantId !== params.restaurantId) {
      throw new Error('not_found');
    }

    // B1: Calculate duration if not provided
    const duration = params.duration || calculateDurationByPartySize(params.partySize, getDurationRules(params.restaurantId));
    
    // Validate duration is multiple of 15
    if (duration % 15 !== 0) {
      throw new Error('invalid_input');
    }

    assertWindowWithinService(
      params.date,
      restaurant.timezone,
      params.windowStart,
      params.windowEnd,
      restaurant.windows
    );

    // Find candidates
    const candidates = findCandidates(
      params.sectorId,
      params.date,
      params.partySize,
      duration,
      restaurant.windows || [],
      restaurant.timezone,
      params.windowStart,
      params.windowEnd,
      params.limit
    );

    if (candidates.length === 0) {
      return res.status(409).json({ error: 'no_capacity' });
    }

    const durationMs = Date.now() - startTime;
    logger.info({
      requestId,
      sectorId: params.sectorId,
      partySize: params.partySize,
      duration: params.duration,
      op: 'discover',
      durationMs,
      outcome: 'success',
    });

    res.status(200).json({
      slotMinutes: 15,
      durationMinutes: duration,
      candidates: candidates.map((c) => ({
        kind: c.kind,
        tableIds: c.tableIds,
        start: c.start,
        end: c.end,
        minCapacity: c.minCapacity,
        maxCapacity: c.maxCapacity,
        score: c.score,
        rationale: c.rationale,
      })),
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      const error = new Error('invalid_input');
      error.message = err.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ');
      next(error);
    } else {
      next(err);
    }
  }
});

/**
 * POST /woki/bookings
 * Create a booking atomically
 */
router.post('/woki/bookings', async (req: Request, res: Response, next: NextFunction) => {
  const requestId = (req as any).requestId;
  const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
  const startTime = Date.now();

  try {
    const body = createBookingSchema.parse(req.body);

    // B1: Calculate duration if not provided
    const durationMinutes = body.durationMinutes || calculateDurationByPartySize(body.partySize, getDurationRules(body.restaurantId));
    
    // Validate duration is multiple of 15
    if (durationMinutes % 15 !== 0) {
      throw new Error('invalid_input');
    }

    const restaurant = db.getRestaurant(body.restaurantId);
    if (!restaurant) {
      throw new Error('not_found');
    }

    assertWindowWithinService(
      body.date,
      restaurant.timezone,
      body.windowStart,
      body.windowEnd,
      restaurant.windows
    );

    const booking = await createBooking(
      body.restaurantId,
      body.sectorId,
      body.partySize,
      durationMinutes,
      body.date,
      idempotencyKey,
      body.windowStart,
      body.windowEnd
    );

    const durationMs = Date.now() - startTime;
    logger.info({
      requestId,
      sectorId: body.sectorId,
      partySize: body.partySize,
      duration: durationMinutes,
      op: 'create_booking',
      durationMs,
      outcome: 'success',
    });

    res.status(201).json(booking);
  } catch (err) {
    if (err instanceof z.ZodError) {
      const error = new Error('invalid_input');
      error.message = err.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ');
      next(error);
    } else {
      next(err);
    }
  }
});

/**
 * GET /woki/bookings/day
 * List bookings for a day
 */
router.get('/woki/bookings/day', async (req: Request, res: Response, next: NextFunction) => {
  const requestId = (req as any).requestId;

  try {
    const params = listBookingsSchema.parse(req.query);

    // Validate restaurant and sector
    const restaurant = db.getRestaurant(params.restaurantId);
    if (!restaurant) {
      throw new Error('not_found');
    }

    const sector = db.getSector(params.sectorId);
    if (!sector || sector.restaurantId !== params.restaurantId) {
      throw new Error('not_found');
    }

    const bookings = db.getBookingsBySectorAndDate(params.sectorId, params.date);

    res.status(200).json({
      date: params.date,
      items: bookings.map((b) => ({
        id: b.id,
        tableIds: b.tableIds,
        partySize: b.partySize,
        start: b.start,
        end: b.end,
        status: b.status,
      })),
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      const error = new Error('invalid_input');
      error.message = err.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ');
      next(error);
    } else {
      next(err);
    }
  }
});

/**
 * DELETE /woki/bookings/:id (Bonus)
 * Delete a booking
 */
router.delete('/woki/bookings/:id', async (req: Request, res: Response, next: NextFunction) => {
  const requestId = (req as any).requestId;
  const bookingId = req.params.id;

  try {
    const booking = db.getBooking(bookingId);
    if (!booking) {
      throw new Error('not_found');
    }

    db.deleteBooking(bookingId);
    metricsStore.incrementBookingCancelled();

    // B5: Try to promote waitlist entries when capacity frees
    try {
      const promoted = await tryPromoteWaitlist(booking.sectorId, booking.start.split('T')[0]);
      if (promoted.length > 0) {
        metricsStore.incrementWaitlistPromotion();
        logger.info({
          requestId,
          bookingId,
          promotedCount: promoted.length,
          op: 'waitlist_promotion',
          outcome: 'success',
        });
      }
    } catch (err) {
      // Waitlist promotion failure shouldn't fail the delete
    }

    logger.info({
      requestId,
      bookingId,
      op: 'delete_booking',
      outcome: 'success',
    });

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

/**
 * B3: POST /woki/bookings/:id/approve
 * Approve a pending booking
 */
router.post('/woki/bookings/:id/approve', async (req: Request, res: Response, next: NextFunction) => {
  const requestId = (req as any).requestId;
  const bookingId = req.params.id;

  try {
    const booking = db.getBooking(bookingId);
    if (!booking) {
      throw new Error('not_found');
    }

    if (booking.status !== 'PENDING') {
      return res.status(400).json({
        error: 'invalid_input',
        detail: 'Booking is not pending approval',
      });
    }

    db.updateBooking(bookingId, { status: 'CONFIRMED' });
    metricsStore.incrementBookingCreated();
    // Note: We don't decrement pending count here, but we could add a method for that

    logger.info({
      requestId,
      bookingId,
      op: 'approve_booking',
      outcome: 'success',
    });

    const updated = db.getBooking(bookingId);
    res.status(200).json(updated);
  } catch (err) {
    next(err);
  }
});

/**
 * B3: POST /woki/bookings/:id/reject
 * Reject a pending booking
 */
router.post('/woki/bookings/:id/reject', async (req: Request, res: Response, next: NextFunction) => {
  const requestId = (req as any).requestId;
  const bookingId = req.params.id;

  try {
    const booking = db.getBooking(bookingId);
    if (!booking) {
      throw new Error('not_found');
    }

    if (booking.status !== 'PENDING') {
      return res.status(400).json({
        error: 'invalid_input',
        detail: 'Booking is not pending approval',
      });
    }

    db.deleteBooking(bookingId);

    logger.info({
      requestId,
      bookingId,
      op: 'reject_booking',
      outcome: 'success',
    });

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

/**
 * B4: POST /woki/blackouts
 * Create a blackout period
 */
const createBlackoutSchema = z.object({
  tableId: z.string().min(1),
  start: z.string().refine((val) => {
    const date = new Date(val);
    return !isNaN(date.getTime());
  }, { message: "Invalid datetime format" }),
  end: z.string().refine((val) => {
    const date = new Date(val);
    return !isNaN(date.getTime());
  }, { message: "Invalid datetime format" }),
  reason: z.string().min(1),
});

router.post('/woki/blackouts', async (req: Request, res: Response, next: NextFunction) => {
  const requestId = (req as any).requestId;

  try {
    const body = createBlackoutSchema.parse(req.body);

    const table = db.getTable(body.tableId);
    if (!table) {
      throw new Error('not_found');
    }

    const now = new Date().toISOString();
    const blackout: Blackout = {
      id: `BL_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`.toUpperCase(),
      tableId: body.tableId,
      start: body.start,
      end: body.end,
      reason: body.reason,
      createdAt: now,
      updatedAt: now,
    };

    db.createBlackout(blackout);

    logger.info({
      requestId,
      blackoutId: blackout.id,
      op: 'create_blackout',
      outcome: 'success',
    });

    res.status(201).json(blackout);
  } catch (err) {
    if (err instanceof z.ZodError) {
      const error = new Error('invalid_input');
      error.message = err.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ');
      next(error);
    } else {
      next(err);
    }
  }
});

/**
 * B4: GET /woki/blackouts
 * List blackouts
 */
const listBlackoutsSchema = z.object({
  tableId: z.string().optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

router.get('/woki/blackouts', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const params = listBlackoutsSchema.parse(req.query);

    let blackouts: Blackout[] = [];
    
    if (params.tableId) {
      blackouts = db.getBlackoutsByTables([params.tableId]);
    } else {
      blackouts = db.getAllBlackouts();
    }

    // Filter by date if provided
    if (params.date) {
      blackouts = blackouts.filter((b) => b.start.startsWith(params.date!));
    }

    res.status(200).json({ items: blackouts });
  } catch (err) {
    if (err instanceof z.ZodError) {
      const error = new Error('invalid_input');
      error.message = err.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ');
      next(error);
    } else {
      next(err);
    }
  }
});

/**
 * B4: DELETE /woki/blackouts/:id
 * Delete a blackout
 */
router.delete('/woki/blackouts/:id', async (req: Request, res: Response, next: NextFunction) => {
  const requestId = (req as any).requestId;
  const blackoutId = req.params.id;

  try {
    const blackout = db.getBlackout(blackoutId);
    if (!blackout) {
      throw new Error('not_found');
    }

    db.deleteBlackout(blackoutId);

    logger.info({
      requestId,
      blackoutId,
      op: 'delete_blackout',
      outcome: 'success',
    });

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

/**
 * B5: GET /woki/waitlist
 * List waitlist entries
 */
const listWaitlistSchema = z.object({
  sectorId: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

router.get('/woki/waitlist', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const params = listWaitlistSchema.parse(req.query);

    const entries = db.getWaitlistEntriesBySectorAndDate(params.sectorId, params.date);

    res.status(200).json({ items: entries });
  } catch (err) {
    if (err instanceof z.ZodError) {
      const error = new Error('invalid_input');
      error.message = err.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ');
      next(error);
    } else {
      next(err);
    }
  }
});

/**
 * B5: DELETE /woki/waitlist/:id
 * Remove from waitlist
 */
router.delete('/woki/waitlist/:id', async (req: Request, res: Response, next: NextFunction) => {
  const requestId = (req as any).requestId;
  const entryId = req.params.id;

  try {
    const entry = db.getWaitlistEntry(entryId);
    if (!entry) {
      throw new Error('not_found');
    }

    db.deleteWaitlistEntry(entryId);

    logger.info({
      requestId,
      entryId,
      op: 'remove_waitlist',
      outcome: 'success',
    });

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

/**
 * B8: GET /woki/metrics
 * Get observability metrics
 */
router.get('/woki/metrics', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const metrics = metricsStore.getMetrics();
    res.status(200).json(metrics);
  } catch (err) {
    next(err);
  }
});

/**
 * B5: Cleanup expired waitlist entries (can be called periodically)
 */
router.post('/woki/waitlist/cleanup', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const count = cleanupExpiredWaitlist();
    res.status(200).json({ cleaned: count });
  } catch (err) {
    next(err);
  }
});

// Error handling middleware
router.use(handleError);

export default router;

