import express from 'express';
import pino from 'pino';
import routes from './routes.js';
import { db } from './store/db.js';
import type { BookingStatus } from './domain/types.js';
import { errorHandler } from './middleware/error-handler.js';

// Use simple logger in test environment to avoid thread stream issues with Vitest
// In tests, use a basic logger without transport to avoid "worker has exited" errors
const logger = process.env.VITEST || process.env.NODE_ENV === 'test'
  ? pino({ level: 'info' }) // Basic logger for tests, no transport to avoid worker exit errors
  : pino({ transport: { target: 'pino-pretty' } });
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());

// Routes
app.use(routes);

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.use(errorHandler);

// Seed data (for development/testing)
if (process.env.NODE_ENV !== 'production' && !process.env.VITEST) {
  const seedData = {
    restaurant: {
      id: 'R1',
      name: 'Bistro Central',
      timezone: 'America/Argentina/Buenos_Aires',
      windows: [
        { start: '12:00', end: '16:00' },
        { start: '20:00', end: '23:45' },
      ],
      createdAt: '2025-10-22T00:00:00-03:00',
      updatedAt: '2025-10-22T00:00:00-03:00',
    },
    sector: {
      id: 'S1',
      restaurantId: 'R1',
      name: 'Main Hall',
      createdAt: '2025-10-22T00:00:00-03:00',
      updatedAt: '2025-10-22T00:00:00-03:00',
    },
    tables: [
      {
        id: 'T1',
        sectorId: 'S1',
        name: 'Table 1',
        minSize: 2,
        maxSize: 2,
        createdAt: '2025-10-22T00:00:00-03:00',
        updatedAt: '2025-10-22T00:00:00-03:00',
      },
      {
        id: 'T2',
        sectorId: 'S1',
        name: 'Table 2',
        minSize: 2,
        maxSize: 4,
        createdAt: '2025-10-22T00:00:00-03:00',
        updatedAt: '2025-10-22T00:00:00-03:00',
      },
      {
        id: 'T3',
        sectorId: 'S1',
        name: 'Table 3',
        minSize: 2,
        maxSize: 4,
        createdAt: '2025-10-22T00:00:00-03:00',
        updatedAt: '2025-10-22T00:00:00-03:00',
      },
      {
        id: 'T4',
        sectorId: 'S1',
        name: 'Table 4',
        minSize: 4,
        maxSize: 6,
        createdAt: '2025-10-22T00:00:00-03:00',
        updatedAt: '2025-10-22T00:00:00-03:00',
      },
      {
        id: 'T5',
        sectorId: 'S1',
        name: 'Table 5',
        minSize: 2,
        maxSize: 2,
        createdAt: '2025-10-22T00:00:00-03:00',
        updatedAt: '2025-10-22T00:00:00-03:00',
      },
    ],
    bookings: [
      {
        id: 'B1',
        restaurantId: 'R1',
        sectorId: 'S1',
        tableIds: ['T2'],
        partySize: 3,
        start: '2025-10-22T20:30:00-03:00',
        end: '2025-10-22T21:15:00-03:00',
        durationMinutes: 45,
        status: 'CONFIRMED' as BookingStatus,
        createdAt: '2025-10-22T18:00:00-03:00',
        updatedAt: '2025-10-22T18:00:00-03:00',
      },
    ],
  };

  db.seed(seedData);
  logger.info('Seed data loaded');
}

// Start server only if not in test mode
if (!process.env.VITEST) {
  app.listen(PORT, () => {
    logger.info(`WokiBrain server running on port ${PORT}`);
  });
}

export default app;

