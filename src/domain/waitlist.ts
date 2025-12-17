/**
 * B5 - Waitlist with Auto-Promotion
 * 
 * Enqueue on 409; when capacity frees, auto-promote if it fits.
 */

import type { ISODateTime } from './types.js';
import { db } from '../store/db.js';
import { createBooking } from './booking-service.js';

export interface WaitlistEntry {
  id: string;
  restaurantId: string;
  sectorId: string;
  partySize: number;
  durationMinutes: number;
  date: string;
  windowStart?: string;
  windowEnd?: string;
  contactInfo?: string; // Optional contact information
  createdAt: ISODateTime;
  expiresAt: ISODateTime; // TTL for waitlist entries
}

/**
 * Adds an entry to the waitlist when no capacity is available.
 */
export function addToWaitlist(
  restaurantId: string,
  sectorId: string,
  partySize: number,
  durationMinutes: number,
  date: string,
  windowStart?: string,
  windowEnd?: string,
  contactInfo?: string,
  ttlMinutes: number = 60
): WaitlistEntry {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMinutes * 60 * 1000);
  
  const entry: WaitlistEntry = {
    id: `WL_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`.toUpperCase(),
    restaurantId,
    sectorId,
    partySize,
    durationMinutes,
    date,
    windowStart,
    windowEnd,
    contactInfo,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
  
  db.createWaitlistEntry(entry);
  return entry;
}

/**
 * Attempts to promote waitlist entries when capacity becomes available.
 * Called when a booking is cancelled or deleted.
 */
export async function tryPromoteWaitlist(
  sectorId: string,
  date: string
): Promise<WaitlistEntry[]> {
  const entries = db.getWaitlistEntriesBySectorAndDate(sectorId, date);
  const promoted: WaitlistEntry[] = [];
  
  // Sort by creation time (FIFO)
  entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  
  for (const entry of entries) {
    // Check if entry is expired
    if (new Date(entry.expiresAt) < new Date()) {
      db.deleteWaitlistEntry(entry.id);
      continue;
    }
    
    try {
      // Try to create booking
      await createBooking(
        entry.restaurantId,
        entry.sectorId,
        entry.partySize,
        entry.durationMinutes,
        entry.date,
        undefined, // No idempotency key for waitlist promotions
        entry.windowStart,
        entry.windowEnd
      );
      
      // Success! Remove from waitlist
      db.deleteWaitlistEntry(entry.id);
      promoted.push(entry);
      
      // Only promote one at a time to avoid conflicts
      break;
    } catch (err) {
      // Still no capacity, keep in waitlist
      continue;
    }
  }
  
  return promoted;
}

/**
 * Cleans up expired waitlist entries.
 */
export function cleanupExpiredWaitlist(): number {
  return db.cleanupExpiredWaitlistEntries();
}

