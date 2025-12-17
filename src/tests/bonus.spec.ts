import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../index.js';
import { db } from '../store/db.js';

describe('Bonus Features – Real Behaviour Coverage', () => {
  beforeEach(() => {
  const now = '2025-10-22T00:00:00-03:00';

  db.clear();
  db.seed({
    restaurant: {
      id: 'R1',
      name: 'Test Restaurant',
      timezone: 'America/Argentina/Buenos_Aires',
      windows: [
        { start: '12:00', end: '16:00' },
        { start: '20:00', end: '23:45' },
      ],
      createdAt: now,
      updatedAt: now,
    },
    sector: {
      id: 'S1',
      restaurantId: 'R1',
      name: 'Main Hall',
      createdAt: now,
      updatedAt: now,
    },
    tables: [
      {
        id: 'T1',
        sectorId: 'S1',
        name: 'T1',
        minSize: 2,
        maxSize: 2,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'T2',
        sectorId: 'S1',
        name: 'T2',
        minSize: 2,
        maxSize: 4,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'T3',
        sectorId: 'S1',
        name: 'T3',
        minSize: 2,
        maxSize: 4,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'T4',
        sectorId: 'S1',
        name: 'T4',
        minSize: 4,
        maxSize: 6,
        createdAt: now,
        updatedAt: now,
      },
    ],
    bookings: [],
  });
});


  it('discover includes score and rationale', async () => {
    const res = await request(app).get('/woki/discover').query({
      restaurantId: 'R1',
      sectorId: 'S1',
      date: '2025-10-22',
      partySize: 5,
      duration: 90,
      windowStart: '20:00',
      windowEnd: '23:45',
    });

    expect(res.status).toBe(200);
    const c = res.body.candidates[0];
    expect(typeof c.score).toBe('number');
    expect(typeof c.rationale).toBe('string');
  });

  it('auto assigns duration when omitted', async () => {
    const res = await request(app).post('/woki/bookings').send({
      restaurantId: 'R1',
      sectorId: 'S1',
      partySize: 2,
      date: '2025-10-22',
      windowStart: '20:00',
      windowEnd: '23:45',
    });

    expect(res.status).toBe(201);
    expect(res.body.durationMinutes).toBeGreaterThan(0);
  });

  it('creates PENDING booking for large groups and approves it', async () => {
    const pending = await request(app).post('/woki/bookings').send({
      restaurantId: 'R1',
      sectorId: 'S1',
      partySize: 10,
      date: '2025-10-22',
      windowStart: '20:00',
      windowEnd: '23:45',
    });

    expect(pending.body.status).toBe('PENDING');

    const approved = await request(app)
      .post(`/woki/bookings/${pending.body.id}/approve`);

    expect(approved.body.status).toBe('CONFIRMED');
  });

  it('blackouts do not break discover candidate generation', async () => {
    await request(app).post('/woki/blackouts').send({
      tableId: 'T4',
      start: '2025-10-22T20:00:00-03:00',
      end: '2025-10-22T22:00:00-03:00',
      reason: 'Maintenance',
    });

    const res = await request(app).get('/woki/discover').query({
      restaurantId: 'R1',
      sectorId: 'S1',
      date: '2025-10-22',
      partySize: 5,
      duration: 90,
      windowStart: '20:00',
      windowEnd: '23:45',
    });

    expect(res.status).toBe(200);
    expect(res.body.candidates.length).toBeGreaterThan(0);
  });

  it('still creates booking when capacity is blocked (implicit waitlist)', async () => {
    for (const t of ['T1', 'T2', 'T3', 'T4']) {
      await request(app).post('/woki/blackouts').send({
        tableId: t,
        start: '2025-10-22T20:00:00-03:00',
        end: '2025-10-22T23:45:00-03:00',
        reason: 'Full block',
      });
    }

    const res = await request(app).post('/woki/bookings').send({
      restaurantId: 'R1',
      sectorId: 'S1',
      partySize: 4,
      durationMinutes: 90,
      date: '2025-10-22',
      windowStart: '20:00',
      windowEnd: '23:45',
    });

    expect(res.status).toBe(201);
  });

  it('metrics endpoint exposes existing keys', async () => {
    const res = await request(app).get('/woki/metrics');

    expect(res.status).toBe(200);
    expect(res.body.bookings).toBeDefined();
    expect(res.body.waitlist).toBeDefined();
  });
});
