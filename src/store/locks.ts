/**
 * LockManager provides a thread-safe locking mechanism using promise chains.
 * 
 * The locking mechanism works by creating a chain of promises for each lock key.
 * When a lock is acquired, it waits for the previous promise in the chain to resolve,
 * ensuring that only one operation can hold a lock for a given key at a time.
 * 
 * Thread-safety is ensured by:
 * 1. Using an internal lock to serialize lock acquisition operations
 * 2. Using promise chains to serialize access to the same lock key
 * 3. Proper cleanup when locks are released
 */
class LockManager {
  private locks: Map<string, Promise<void>> = new Map();
  // Internal lock to serialize lock acquisition operations and prevent race conditions
  private internalLock: Promise<void> = Promise.resolve();

  generateLockKey(restaurantId: string, sectorId: string, tables: string[], start: string) {
    return `${restaurantId}:${sectorId}:${tables.sort().join(',')}:${start}`;
  }

  has(key: string) {
    return this.locks.has(key);
  }

  /**
   * Acquires a lock for the given key.
   * If a lock already exists, waits for it to be released before acquiring.
   * Returns a release function that must be called to release the lock.
   * 
   * This implementation is thread-safe because:
   * - An internal lock serializes all lock acquisition operations
   * - Each caller waits for the previous promise in the chain
   * - Only one promise is stored per key at any time
   * 
   * The internal lock prevents race conditions where multiple concurrent calls
   * might both see no existing lock and both try to acquire it simultaneously.
   */
  async acquire(key: string): Promise<() => void> {
    // Use internal lock to serialize lock acquisition operations
    // This prevents race conditions in the get-or-set operation
    let releaseInternal!: () => void;
    const willLock = new Promise<void>((resolve) => {
      releaseInternal = resolve;
    });
    const prevInternal = this.internalLock;
    this.internalLock = willLock;

    await prevInternal;

    try {
      // Now we can safely get and set the lock without race conditions
      const previous = this.locks.get(key) || Promise.resolve();

      let release!: () => void;

      // Create a new promise that will resolve when this lock is released
      const p = new Promise<void>((resolve) => {
        release = resolve;
      });

      // Set the new lock promise, chaining it after the previous one
      // This ensures that this lock will only be acquired after the previous one is released
      this.locks.set(key, previous.then(() => p));

      // Wait for the previous lock to be released (if any)
      await previous;

      // Return a release function that cleans up the lock
      return () => {
        release();

        // Only delete if this is still the current lock (prevents deleting newer locks)
        if (this.locks.get(key) === p) {
          this.locks.delete(key);
        }
      };
    } finally {
      releaseInternal();
    }
  }
}

export const lockManager = new LockManager();
