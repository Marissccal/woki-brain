import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../index.js';
import { db } from '../store/db.js';

describe('API Endpoints', () => {
  beforeEach(() => {
    db.clear();
    
    // Seed test data
    db.seed({
      restaurant: {
        id: 'R1',
        name: 'Test Restaurant',
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
          id: 'T4',
          sectorId: 'S1',
          name: 'Table 4',
          minSize: 4,
          maxSize: 6,
          createdAt: '2025-10-22T00:00:00-03:00',
          updatedAt: '2025-10-22T00:00:00-03:00',
        },
      ],
      bookings: [],
    });
  });

  describe('GET /woki/discover', () => {
    it('should return candidates for available slots', async () => {
      const res = await request(app)
        .get('/woki/discover')
        .query({
          restaurantId: 'R1',
          sectorId: 'S1',
          date: '2025-10-22',
          partySize: 5,
          duration: 90,
          windowStart: '20:00',
          windowEnd: '23:45',
        });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('candidates');
      expect(res.body.candidates.length).toBeGreaterThan(0);
      expect(res.body.candidates[0]).toHaveProperty('tableIds');
      expect(res.body.candidates[0]).toHaveProperty('start');
      expect(res.body.candidates[0]).toHaveProperty('end');
    });

    it('should return 409 when no capacity available', async () => {
      // Create a long booking to fill most of the window (20:00-23:45 = 225 minutes)
      // Using 210 minutes leaves only 15 minutes free, which is insufficient for 90 minutes
      await request(app)
        .post('/woki/bookings')
        .send({
          restaurantId: 'R1',
          sectorId: 'S1',
          partySize: 6,
          durationMinutes: 210, // Leaves only 15 min free (insufficient for 90 min booking)
          date: '2025-10-22',
          windowStart: '20:00',
          windowEnd: '23:45',
        });


      const res = await request(app)
        .get('/woki/discover')
        .query({
          restaurantId: 'R1',
          sectorId: 'S1',
          date: '2025-10-22',
          partySize: 5,
          duration: 90,
          windowStart: '20:00',
          windowEnd: '23:45',
        });

      expect(res.status).toBe(409);
      expect(res.body.error).toBe('no_capacity');
    });

    it('should return 422 when window is outside service hours', async () => {
      const res = await request(app)
        .get('/woki/discover')
        .query({
          restaurantId: 'R1',
          sectorId: 'S1',
          date: '2025-10-22',
          partySize: 5,
          duration: 90,
          windowStart: '17:00',
          windowEnd: '19:00',
        });

      expect(res.status).toBe(422);
      expect(res.body.error).toBe('outside_service_window');
    });
  });

  describe('POST /woki/bookings', () => {
    it('should create a booking successfully', async () => {
      const res = await request(app)
        .post('/woki/bookings')
        .send({
          restaurantId: 'R1',
          sectorId: 'S1',
          partySize: 5,
          durationMinutes: 90,
          date: '2025-10-22',
          windowStart: '20:00',
          windowEnd: '23:45',
        });

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('id');
      expect(res.body.status).toBe('CONFIRMED');
      expect(res.body.tableIds).toBeDefined();
      expect(res.body.start).toBeDefined();
      expect(res.body.end).toBeDefined();
    });

    it('should be idempotent with same Idempotency-Key', async () => {
      const idempotencyKey = 'test-key-123';

      const res1 = await request(app)
        .post('/woki/bookings')
        .set('Idempotency-Key', idempotencyKey)
        .send({
          restaurantId: 'R1',
          sectorId: 'S1',
          partySize: 5,
          durationMinutes: 90,
          date: '2025-10-22',
          windowStart: '20:00',
          windowEnd: '23:45',
        });

      const res2 = await request(app)
        .post('/woki/bookings')
        .set('Idempotency-Key', idempotencyKey)
        .send({
          restaurantId: 'R1',
          sectorId: 'S1',
          partySize: 5,
          durationMinutes: 90,
          date: '2025-10-22',
          windowStart: '20:00',
          windowEnd: '23:45',
        });

      expect(res1.status).toBe(201);
      expect(res2.status).toBe(201);
      expect(res1.body.id).toBe(res2.body.id);
    });

    it('should handle concurrent requests (one succeeds, one fails)', async () => {
      const promises = [
        request(app)
          .post('/woki/bookings')
          .send({
            restaurantId: 'R1',
            sectorId: 'S1',
            partySize: 5,
            durationMinutes: 90,
            date: '2025-10-22',
            windowStart: '20:00',
            windowEnd: '23:45',
          }),
        request(app)
          .post('/woki/bookings')
          .send({
            restaurantId: 'R1',
            sectorId: 'S1',
            partySize: 5,
            durationMinutes: 90,
            date: '2025-10-22',
            windowStart: '20:00',
            windowEnd: '23:45',
          }),
      ];

      const results = await Promise.all(promises);
      const statuses = results.map((r) => r.status);
      
      // One should succeed (201), one should fail (409)
      expect(statuses).toContain(201);
      expect(statuses).toContain(409);
    });

    it('should return 422 when window is outside service hours', async () => {
      const res = await request(app)
        .post('/woki/bookings')
        .send({
          restaurantId: 'R1',
          sectorId: 'S1',
          partySize: 5,
          durationMinutes: 90,
          date: '2025-10-22',
          windowStart: '17:00',
          windowEnd: '19:00',
        });

      expect(res.status).toBe(422);
      expect(res.body.error).toBe('outside_service_window');
    });
  });

  describe('GET /woki/bookings/day', () => {
    it('should list bookings for a day', async () => {
      // Create a booking first
      await request(app)
        .post('/woki/bookings')
        .send({
          restaurantId: 'R1',
          sectorId: 'S1',
          partySize: 5,
          durationMinutes: 90,
          date: '2025-10-22',
          windowStart: '20:00',
          windowEnd: '23:45',
        });

      const res = await request(app)
        .get('/woki/bookings/day')
        .query({
          restaurantId: 'R1',
          sectorId: 'S1',
          date: '2025-10-22',
        });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('date', '2025-10-22');
      expect(res.body.items.length).toBeGreaterThan(0);
      expect(res.body.items[0]).toHaveProperty('id');
      expect(res.body.items[0]).toHaveProperty('tableIds');
    });
  });
});

