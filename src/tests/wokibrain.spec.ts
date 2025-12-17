import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../store/db.js';
import { findCandidates, selectBestCandidate } from '../domain/wokibrain.js';
import { createBooking } from '../domain/booking-service.js';

describe('WokiBrain', () => {
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
          status: 'CONFIRMED',
          createdAt: '2025-10-22T18:00:00-03:00',
          updatedAt: '2025-10-22T18:00:00-03:00',
        },
      ],
    });
  });

  describe('Happy single table', () => {
    it('should find a perfect gap on a single table', () => {
      const candidates = findCandidates(
        'S1',
        '2025-10-22',
        5,
        90,
        [{ start: '20:00', end: '23:45' }],
        'America/Argentina/Buenos_Aires',
        '20:00',
        '23:45',
        10
      );

      expect(candidates.length).toBeGreaterThan(0);
      const singleCandidate = candidates.find((c) => c.kind === 'single');
      expect(singleCandidate).toBeDefined();
      expect(singleCandidate?.tableIds).toHaveLength(1);
      expect(singleCandidate?.tableIds[0]).toBe('T4'); // T4 fits party of 5
    });
  });

  describe('Happy combo', () => {
    it('should find a valid combination when singles cannot fit', async () => {
      // Book T4 for the entire window
      await createBooking('R1', 'S1', 6, 180, '2025-10-22', undefined, '20:00', '23:45');

      const candidates = findCandidates(
        'S1',
        '2025-10-22',
        5,
        90,
        [{ start: '20:00', end: '23:45' }],
        'America/Argentina/Buenos_Aires',
        '20:00',
        '23:45',
        10
      );

      expect(candidates.length).toBeGreaterThan(0);
      const comboCandidate = candidates.find((c) => c.kind === 'combo');
      expect(comboCandidate).toBeDefined();
      expect(comboCandidate?.tableIds.length).toBeGreaterThan(1);
      
      // T2 + T3 should work (2-4 + 2-4 = 4-8 capacity)
      const t2t3Combo = candidates.find(
        (c) => c.kind === 'combo' && c.tableIds.includes('T2') && c.tableIds.includes('T3')
      );
      expect(t2t3Combo).toBeDefined();
    });
  });

  describe('Boundary conditions', () => {
    it('should accept bookings that touch at end (end-exclusive)', async () => {
      // Create first booking
      const booking1 = await createBooking(
        'R1',
        'S1',
        2,
        90,
        '2025-10-22',
        undefined,
        '20:00',
        '23:45'
      );

      // Create second booking that starts exactly when first ends
      const booking2 = await createBooking(
        'R1',
        'S1',
        2,
        60,
        '2025-10-22',
        undefined,
        '21:30',
        '23:45'
      );

      expect(booking1.end).toBe(booking2.start);
      
      // Both should be confirmed
      expect(booking1.status).toBe('CONFIRMED');
      expect(booking2.status).toBe('CONFIRMED');
    });
  });

  describe('Determinism', () => {
    it('should return the same candidate for identical inputs', () => {
      const candidates1 = findCandidates(
        'S1',
        '2025-10-22',
        5,
        90,
        [{ start: '20:00', end: '23:45' }],
        'America/Argentina/Buenos_Aires',
        '20:00',
        '23:45',
        1
      );

      const candidates2 = findCandidates(
        'S1',
        '2025-10-22',
        5,
        90,
        [{ start: '20:00', end: '23:45' }],
        'America/Argentina/Buenos_Aires',
        '20:00',
        '23:45',
        1
      );

      expect(candidates1[0]?.tableIds).toEqual(candidates2[0]?.tableIds);
      expect(candidates1[0]?.start).toBe(candidates2[0]?.start);
      expect(candidates1[0]?.end).toBe(candidates2[0]?.end);
    });
  });
});

