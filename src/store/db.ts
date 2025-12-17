import type {
  Restaurant,
  Sector,
  Table,
  Booking,
  ISODateTime,
} from '../domain/types.js';
import type { Blackout } from '../domain/blackouts.js';
import type { WaitlistEntry } from '../domain/waitlist.js';

class InMemoryDB {
  private restaurants: Map<string, Restaurant> = new Map();
  private sectors: Map<string, Sector> = new Map();
  private tables: Map<string, Table> = new Map();
  private bookings: Map<string, Booking> = new Map();
  private idempotencyCache: Map<string, { booking: Booking; expiresAt: number }> = new Map();
  private blackouts: Map<string, Blackout> = new Map(); // B4
  private waitlist: Map<string, WaitlistEntry> = new Map(); // B5
  private lock: Promise<void> = Promise.resolve();

  /**
   * Executes a function exclusively, ensuring only one operation runs at a time.
   * 
   * This method uses a promise chain to serialize operations, preventing race conditions.
   * Each call waits for the previous operation to complete before executing.
   * 
   * Thread-safety is ensured by:
   * - Using a promise chain to serialize all exclusive operations
   * - Each caller waits for the previous promise in the chain
   * - Proper cleanup in the finally block
   * 
   * @param fn - The function to execute exclusively
   * @returns The result of the function execution
   */
  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;

    // Create a new promise that will resolve when this operation completes
    const willLock = new Promise<void>((res) => (release = res));
    
    // Get the previous lock promise (or a resolved one if none exists)
    const prev = this.lock;
    
    // Set this operation's promise as the new lock, chaining it after the previous one
    // This ensures this operation will only run after the previous one completes
    this.lock = willLock;

    // Wait for the previous operation to complete (if any)
    await prev;

    try {
      // Execute the function exclusively
      return await fn();
    } finally {
      // Always release the lock, allowing the next operation to proceed
      release();
    }
  }

  // Restaurants
  createRestaurant(restaurant: Restaurant): void {
    this.restaurants.set(restaurant.id, restaurant);
  }

  getRestaurant(id: string): Restaurant | undefined {
    return this.restaurants.get(id);
  }

  // Sectors
  createSector(sector: Sector): void {
    this.sectors.set(sector.id, sector);
  }

  getSector(id: string): Sector | undefined {
    return this.sectors.get(id);
  }

  getSectorsByRestaurant(restaurantId: string): Sector[] {
    return Array.from(this.sectors.values()).filter(
      (s) => s.restaurantId === restaurantId
    );
  }

  // Tables
  createTable(table: Table): void {
    this.tables.set(table.id, table);
  }

  getTable(id: string): Table | undefined {
    return this.tables.get(id);
  }

  getTablesBySector(sectorId: string): Table[] {
    return Array.from(this.tables.values()).filter(
      (t) => t.sectorId === sectorId
    );
  }

  // Bookings
  createBooking(booking: Booking): void {
    this.bookings.set(booking.id, booking);
  }

  getBooking(id: string): Booking | undefined {
    return this.bookings.get(id);
  }

  getBookingsBySectorAndDate(
    sectorId: string,
    date: string
  ): Booking[] {
    return Array.from(this.bookings.values())
      .filter(
        (b) =>
          b.sectorId === sectorId &&
          b.status === 'CONFIRMED' &&
          b.start.startsWith(date)
      )
      .sort((a, b) => a.start.localeCompare(b.start));
  }

  getBookingsByTablesAndDate(
    tableIds: string[],
    date: string
  ): Booking[] {
    const tableIdSet = new Set(tableIds);

    return Array.from(this.bookings.values())
      .filter(
        (b) =>
          b.status === 'CONFIRMED' &&
          b.start.startsWith(date) &&
          b.tableIds.some((tid) => tableIdSet.has(tid))
      )
      .sort((a, b) => a.start.localeCompare(b.start));
  }

  updateBooking(id: string, updates: Partial<Booking>): void {
    const booking = this.bookings.get(id);
    if (booking) {
      const updated = {
        ...booking,
        ...updates,
        updatedAt: new Date().toISOString(),
      };
      this.bookings.set(id, updated);
    }
  }

  deleteBooking(id: string): void {
    this.bookings.delete(id);
  }

  // Idempotency
  setIdempotency(key: string, booking: Booking, ttlSeconds: number = 60): void {
    const expiresAt = Date.now() + ttlSeconds * 1000;
    this.idempotencyCache.set(key, { booking, expiresAt });
  }

  getIdempotency(key: string): Booking | undefined {
    const entry = this.idempotencyCache.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.idempotencyCache.delete(key);
      return undefined;
    }
    return entry.booking;
  }

  // Seed data helper
  seed(data: {
    restaurant: Restaurant;
    sector: Sector;
    tables: Table[];
    bookings?: Booking[];
  }): void {
    this.createRestaurant(data.restaurant);
    this.createSector(data.sector);
    data.tables.forEach((table) => this.createTable(table));
    if (data.bookings) {
      data.bookings.forEach((booking) => this.createBooking(booking));
    }
  }

  // B4: Blackouts
  createBlackout(blackout: Blackout): void {
    this.blackouts.set(blackout.id, blackout);
  }

  getBlackout(id: string): Blackout | undefined {
    return this.blackouts.get(id);
  }

  getBlackoutsByTables(tableIds: string[]): Blackout[] {
    const tableIdSet = new Set(tableIds);
    return Array.from(this.blackouts.values()).filter((b) =>
      tableIdSet.has(b.tableId)
    );
  }

  getAllBlackouts(): Blackout[] {
    return Array.from(this.blackouts.values());
  }

  deleteBlackout(id: string): void {
    this.blackouts.delete(id);
  }

  // B5: Waitlist
  createWaitlistEntry(entry: WaitlistEntry): void {
    this.waitlist.set(entry.id, entry);
  }

  getWaitlistEntry(id: string): WaitlistEntry | undefined {
    return this.waitlist.get(id);
  }

  getWaitlistEntriesBySectorAndDate(
    sectorId: string,
    date: string
  ): WaitlistEntry[] {
    return Array.from(this.waitlist.values())
      .filter(
        (e) =>
          e.sectorId === sectorId &&
          e.date === date &&
          new Date(e.expiresAt) > new Date()
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  deleteWaitlistEntry(id: string): void {
    this.waitlist.delete(id);
  }

  cleanupExpiredWaitlistEntries(): number {
    const now = new Date();
    let count = 0;
    for (const [id, entry] of this.waitlist.entries()) {
      if (new Date(entry.expiresAt) < now) {
        this.waitlist.delete(id);
        count++;
      }
    }
    return count;
  }

  // Clear all (for testing)
  clear(): void {
    this.restaurants.clear();
    this.sectors.clear();
    this.tables.clear();
    this.bookings.clear();
    this.idempotencyCache.clear();
    this.blackouts.clear(); // B4
    this.waitlist.clear(); // B5
  }
}

export const db = new InMemoryDB();

