/**
 * B8 - Observability
 * 
 * Minimal /metrics counters and statistics.
 */

export interface Metrics {
  bookings: {
    created: number;
    cancelled: number;
    conflicts: number;
    pending: number;
    confirmed: number;
  };
  performance: {
    assignmentTimes: number[]; // Array of assignment times in ms
    p95AssignmentTime?: number;
    avgAssignmentTime?: number;
  };
  locks: {
    acquisitions: number;
    contentions: number; // Number of times lock was already held
  };
  waitlist: {
    entries: number;
    promotions: number;
  };
}

class MetricsStore {
  private metrics: Metrics = {
    bookings: {
      created: 0,
      cancelled: 0,
      conflicts: 0,
      pending: 0,
      confirmed: 0,
    },
    performance: {
      assignmentTimes: [],
    },
    locks: {
      acquisitions: 0,
      contentions: 0,
    },
    waitlist: {
      entries: 0,
      promotions: 0,
    },
  };
  
  // Keep only last 1000 assignment times for memory efficiency
  private readonly MAX_ASSIGNMENT_TIMES = 1000;
  
  incrementBookingCreated(): void {
    this.metrics.bookings.created++;
    this.metrics.bookings.confirmed++;
  }
  
  incrementBookingCancelled(): void {
    this.metrics.bookings.cancelled++;
  }
  
  incrementBookingConflict(): void {
    this.metrics.bookings.conflicts++;
  }
  
  incrementBookingPending(): void {
    this.metrics.bookings.pending++;
  }
  
  recordAssignmentTime(ms: number): void {
    this.metrics.performance.assignmentTimes.push(ms);
    
    // Keep only last N times
    if (this.metrics.performance.assignmentTimes.length > this.MAX_ASSIGNMENT_TIMES) {
      this.metrics.performance.assignmentTimes.shift();
    }
    
    // Calculate statistics
    this.updatePerformanceStats();
  }
  
  incrementLockAcquisition(): void {
    this.metrics.locks.acquisitions++;
  }
  
  incrementLockContention(): void {
    this.metrics.locks.contentions++;
  }
  
  incrementWaitlistEntry(): void {
    this.metrics.waitlist.entries++;
  }
  
  incrementWaitlistPromotion(): void {
    this.metrics.waitlist.promotions++;
  }
  
  private updatePerformanceStats(): void {
    const times = this.metrics.performance.assignmentTimes;
    if (times.length === 0) return;
    
    // Calculate average
    const sum = times.reduce((a, b) => a + b, 0);
    this.metrics.performance.avgAssignmentTime = sum / times.length;
    
    // Calculate P95
    const sorted = [...times].sort((a, b) => a - b);
    const p95Index = Math.floor(sorted.length * 0.95);
    this.metrics.performance.p95AssignmentTime = sorted[p95Index];
  }
  
  getMetrics(): Metrics {
    // Update stats before returning
    this.updatePerformanceStats();
    
    return {
      ...this.metrics,
      performance: {
        ...this.metrics.performance,
        // Don't expose raw array, just stats
        assignmentTimes: [],
      },
    };
  }
  
  reset(): void {
    this.metrics = {
      bookings: {
        created: 0,
        cancelled: 0,
        conflicts: 0,
        pending: 0,
        confirmed: 0,
      },
      performance: {
        assignmentTimes: [],
      },
      locks: {
        acquisitions: 0,
        contentions: 0,
      },
      waitlist: {
        entries: 0,
        promotions: 0,
      },
    };
  }
}

export const metricsStore = new MetricsStore();

