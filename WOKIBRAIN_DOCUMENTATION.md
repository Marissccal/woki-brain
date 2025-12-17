# Technical Documentation: WokiBrain
## Restaurant Booking Engine

---

## Table of Contents

1. [Introduction](#introduction)
2. [General Architecture](#general-architecture)
3. [Data Model](#data-model)
4. [Main Components](#main-components)
5. [Data Flow](#data-flow)
6. [Technical Details by Module](#technical-details-by-module)
7. [API Endpoints](#api-endpoints)
8. [Key Algorithms](#key-algorithms)
9. [Concurrency Handling](#concurrency-handling)
10. [Usage Examples](#usage-examples)

---

## Introduction

**WokiBrain** is a restaurant booking engine that allows finding availability of individual tables or table combinations to accommodate groups of diners. The system uses a deterministic algorithm called "WokiBrain" to select the best option among multiple candidates.

### Main Features

- **Gap Discovery**: Finds availability gaps in individual tables
- **Table Combinations**: Allows combining multiple tables for large groups
- **Deterministic Selection**: WokiBrain algorithm that always chooses the same option for the same inputs
- **Concurrency**: Lock system to prevent double booking
- **Idempotency**: Support for idempotent operations via `Idempotency-Key`
- **Service Windows**: Respects restaurant service hours
- **15-Minute Grid**: All bookings are aligned to 15-minute intervals

### Implemented Bonus Features

- **Score/Rationale in API**: Candidates include score and human-readable justification
- **Variable Duration by Party Size**: Automatic duration calculation based on group size
- **Large-Group Approval**: PENDING bookings for large groups that require approval
- **Blackouts**: Blocking periods per table for maintenance or events
- **Waitlist with Auto-Promotion**: Automatic waitlist when there is no capacity
- **Observability**: Metrics endpoint with counters and performance statistics

---

## General Architecture

### Project Structure

```
src/
├── index.ts                 # Entry point, server configuration
├── routes.ts                # HTTP endpoints definition
├── middleware/              # Custom middleware
│   └── error-handler.ts    # Centralized error handling
├── domain/                  # Business logic
│   ├── types.ts            # TypeScript type definitions
│   ├── gaps.ts             # Gap discovery algorithms
│   ├── wokibrain.ts        # WokiBrain selection strategy
│   ├── booking-service.ts  # Booking creation service
│   ├── duration-rules.ts   # B1: Duration rules by group size
│   ├── blackouts.ts        # B4: Blocked periods management
│   └── waitlist.ts         # B5: Waitlist management
├── store/                   # Persistence layer
│   ├── db.ts               # In-memory database
│   ├── locks.ts            # Lock system for concurrency
│   └── metrics.ts          # B8: Metrics storage
└── tests/                   # Unit and integration tests
    ├── api.spec.ts
    ├── wokibrain.spec.ts
    └── bonus.spec.ts       # Bonus features tests
```

### Technology Stack

- **Runtime**: Node.js with TypeScript
- **Framework**: Express.js
- **Validation**: Zod
- **Logging**: Pino
- **Testing**: Vitest
- **Persistence**: In-memory (JavaScript Maps)

---

## Data Model

### Main Entities

#### 1. Restaurant

```typescript
interface Restaurant {
  id: string;                    // Unique identifier
  name: string;                   // Restaurant name
  timezone: string;               // IANA timezone (e.g.: "America/Argentina/Buenos_Aires")
  windows?: Array<{                // Optional service windows
    start: string;                // Format "HH:mm"
    end: string;                  // Format "HH:mm"
  }>;
  createdAt: ISODateTime;         // Creation timestamp
  updatedAt: ISODateTime;         // Last update timestamp
}
```

**Purpose**: Represents a restaurant with its service hours configuration.

**Example**:
```json
{
  "id": "R1",
  "name": "Bistro Central",
  "timezone": "America/Argentina/Buenos_Aires",
  "windows": [
    { "start": "12:00", "end": "16:00" },
    { "start": "20:00", "end": "23:45" }
  ]
}
```

#### 2. Sector

```typescript
interface Sector {
  id: string;                    // Unique identifier
  restaurantId: string;           // Reference to restaurant
  name: string;                   // Sector name (e.g.: "Main Hall", "Terrace")
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}
```

**Purpose**: Groups tables within a restaurant. A restaurant can have multiple sectors.

#### 3. Table

```typescript
interface Table {
  id: string;                    // Unique identifier
  sectorId: string;               // Reference to sector
  name: string;                   // Table name
  minSize: number;                // Minimum diner capacity
  maxSize: number;                // Maximum diner capacity
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}
```

**Purpose**: Represents a physical table with its capacity range.

**Example**:
```json
{
  "id": "T4",
  "sectorId": "S1",
  "name": "Table 4",
  "minSize": 4,
  "maxSize": 6
}
```

#### 4. Booking

```typescript
interface Booking {
  id: string;                    // Unique identifier
  restaurantId: string;
  sectorId: string;
  tableIds: string[];             // Array of table IDs (can be 1 or more for combos)
  partySize: number;              // Number of diners
  start: ISODateTime;             // Booking start [start, end)
  end: ISODateTime;                // Booking end (exclusive)
  durationMinutes: number;        // Duration in minutes
  status: BookingStatus;          // 'CONFIRMED' | 'CANCELLED' | 'PENDING' (B3)
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}
```

**Purpose**: Represents a confirmed or cancelled booking.

**Important Note**: Intervals are `[start, end)`, meaning `end` is exclusive. This means two bookings can touch without conflict: one ending at 21:00 and another starting at 21:00 are valid.

#### 5. Gap (Availability Gap)

```typescript
interface Gap {
  start: ISODateTime;            // Gap start
  end: ISODateTime;               // Gap end
}
```

**Purpose**: Represents a time interval where one or more tables are available.

#### 6. Candidate

```typescript
interface Candidate {
  kind: 'single' | 'combo';       // Type: individual table or combination
  tableIds: string[];             // IDs of involved tables
  start: ISODateTime;             // Proposed start time
  end: ISODateTime;                // Proposed end time
  minCapacity?: number;           // Candidate minimum capacity
  maxCapacity?: number;           // Candidate maximum capacity
  score?: number;                 // WokiBrain score (lower is better)
  rationale?: string;             // Human-readable justification of selection
}
```

**Purpose**: Represents a viable option to accommodate a group of diners.

---

## Main Components

### 1. In-Memory Database (`src/store/db.ts`)

#### Class: `InMemoryDB`

**Responsibility**: Manage storage of all entities in memory using JavaScript `Map`.

**Internal Structure**:
```typescript
class InMemoryDB {
  private restaurants: Map<string, Restaurant>;
  private sectors: Map<string, Sector>;
  private tables: Map<string, Table>;
  private bookings: Map<string, Booking>;
  private idempotencyCache: Map<string, { booking: Booking; expiresAt: number }>;
}
```

**Main Methods**:

1. **Restaurant Management**:
   - `createRestaurant(restaurant: Restaurant): void`
   - `getRestaurant(id: string): Restaurant | undefined`

2. **Sector Management**:
   - `createSector(sector: Sector): void`
   - `getSector(id: string): Sector | undefined`
   - `getSectorsByRestaurant(restaurantId: string): Sector[]`

3. **Table Management**:
   - `createTable(table: Table): void`
   - `getTable(id: string): Table | undefined`
   - `getTablesBySector(sectorId: string): Table[]`

4. **Booking Management**:
   - `createBooking(booking: Booking): void`
   - `getBooking(id: string): Booking | undefined`
   - `getBookingsBySectorAndDate(sectorId: string, date: string): Booking[]`
   - `getBookingsByTablesAndDate(tableIds: string[], date: string): Booking[]`
   - `updateBooking(id: string, updates: Partial<Booking>): void`
   - `deleteBooking(id: string): void`

5. **Idempotency**:
   - `setIdempotency(key: string, booking: Booking, ttlSeconds: number): void`
   - `getIdempotency(key: string): Booking | undefined`

6. **Utilities**:
   - `seed(data): void` - Loads initial data
   - `clear(): void` - Clears entire database (useful for tests)

**Special Features**:

- **Idempotency Cache**: Stores bookings created with `Idempotency-Key` for 60 seconds (configurable)
- **Optimized Searches**: Filters and sorts bookings by date and sector efficiently
- **Thread-Safe**: Uses `runExclusive` for atomic operations

---

### 2. Lock System (`src/store/locks.ts`)

#### Class: `LockManager`

**Responsibility**: Manage locks to prevent race conditions in concurrent operations.

**How It Works**:

1. **Lock Key Generation**:
   ```typescript
   generateLockKey(restaurantId, sectorId, tables, start)
   // Example: "R1:S1:T2,T3:2025-10-22T20:00:00-03:00"
   ```

2. **Lock Acquisition**:
   ```typescript
   const releaseLock = await lockManager.acquire(lockKey);
   try {
     // Critical operation
   } finally {
     releaseLock(); // Always release the lock
   }
   ```

**Implementation**:

The system uses a Promise chain to create a waiting queue:
- Each lock is a Promise that resolves when the previous lock is released
- Multiple requests for the same lock wait in order
- The lock is released when `releaseLock()` is called

**Usage Example**:
```typescript
// Request 1 acquires the lock
const release1 = await lockManager.acquire("R1:S1:T4:20:00");

// Request 2 waits (the Promise chains)
const release2 = await lockManager.acquire("R1:S1:T4:20:00");

// Request 1 releases → Request 2 can proceed
release1();
```

---

### 3. Gap Discovery (`src/domain/gaps.ts`)

#### Function: `findTableGaps`

**Purpose**: Finds all availability gaps for an individual table on a specific day.

**Algorithm**:

1. Gets all confirmed bookings for the table on that date
2. If there are service windows, searches for gaps within each window
3. If there are no windows, treats the full day as available
4. For each window:
   - Sorts bookings by start time
   - Finds gaps between consecutive bookings
   - Adds initial gap (from window start to first booking)
   - Adds final gap (from last booking to window end)

**Visual Example**:
```
Window: [20:00 - 23:45]
Bookings: [20:30-21:15], [22:00-22:45]

Gaps found:
- [20:00 - 20:30] ✓
- [21:15 - 22:00] ✓
- [22:45 - 23:45] ✓
```

#### Function: `findComboGaps`

**Purpose**: Finds gaps where multiple tables are simultaneously available.

**Algorithm**:

1. Gets individual gaps for each table in the combination
2. Calculates the intersection of all gap sets
3. **B4**: Filters gaps excluding blackout periods for all tables in the combo
4. Returns only intervals where ALL tables are free and without blackouts

**Example**:
```
Table T2: gaps = [[20:00-20:30], [21:15-22:00]]
Table T3: gaps = [[20:00-20:45], [21:30-22:00]]

Intersection (T2 + T3):
- [20:00-20:30] ✓ (both free)
- [21:30-22:00] ✓ (both free)
```

#### Function: `intersectGaps`

**Intersection Algorithm**:

Uses two pointers to traverse both sorted gap arrays:
- Compares gaps and finds overlap
- Advances the pointer of the gap that ends first
- Complexity: O(n + m) where n and m are the array sizes

#### Function: `filterGapsByDuration`

**Purpose**: Filters gaps to include only those that can accommodate the requested duration, rounding to 15-minute slots.

**Process**:

1. Rounds the gap start up to the next 15-minute slot
2. Rounds the gap end down to the previous 15-minute slot
3. Calculates available duration
4. If available duration ≥ requested duration:
   - Generates all possible start slots within the gap
   - Each slot is separated by 15 minutes
   - Returns all valid candidates

**Example**:
```
Gap: [20:07 - 21:35]
Requested duration: 90 minutes

Rounded: [20:15 - 21:30]
Available duration: 75 minutes

Result: [] (does not fit)
```

```
Gap: [20:00 - 22:00]
Requested duration: 90 minutes

Generated slots:
- [20:00 - 21:30] ✓
- [20:15 - 21:45] ✓
- [20:30 - 22:00] ✓
```

#### Function: `calculateComboCapacity`

**Combo Capacity Heuristic**:

```typescript
minCapacity = sum(minSize of all tables)
maxCapacity = sum(maxSize of all tables)
```

**Example**:
```
T2: minSize=2, maxSize=4
T3: minSize=2, maxSize=4

Combo T2+T3:
minCapacity = 2 + 2 = 4
maxCapacity = 4 + 4 = 8
```

**Justification**: This heuristic is simple, predictable and allows maximum flexibility to accommodate groups in combined tables.

#### Timezone Utility Functions

**`toZonedIso(date, time, timeZone)`**: Converts a local date and time to ISO string considering the restaurant timezone.

**`getTimeZoneOffset(date, timeZone)`**: Calculates the offset in minutes of a specific timezone for a given date.

---

### 4. WokiBrain Strategy (`src/domain/wokibrain.ts`)

#### Function: `findCandidates`

**Purpose**: Finds all valid candidates (individual tables and combinations) that can accommodate a group.

**Process**:

1. **Service Window Filtering**:
   - If a specific window is requested, filters service windows that intersect
   - If there is no intersection, returns empty array

2. **Individual Table Search**:
   - Iterates over all tables in the sector
   - Verifies that the group size fits (minSize ≤ partySize ≤ maxSize)
   - Finds gaps and filters by duration
   - Filters by requested window if it exists
   - Creates candidates of type 'single'

3. **Combination Search**:
   - Generates all combinations of 2 or more tables
   - For each combination:
     - Calculates combo capacity
     - Verifies that the group fits
     - Finds combo gaps (intersection)
     - Filters by duration and window
     - Creates candidates of type 'combo'

4. **Sorting (WokiBrain Strategy)**:
   ```typescript
   candidates.sort((a, b) => {
     // 1. Prefer individual tables over combos
     if (a.kind !== b.kind) {
       return a.kind === 'single' ? -1 : 1;
     }
     
     // 2. Prefer earliest start time
     const timeDiff = a.start.localeCompare(b.start);
     if (timeDiff !== 0) return timeDiff;
     
     // 3. Prefer minimum waste (smallest capacity that still fits)
     const wasteA = a.maxCapacity! - partySize;
     const wasteB = b.maxCapacity! - partySize;
     if (wasteA !== wasteB) return wasteA - wasteB;
     
     // 4. Deterministic ordering by table IDs
     const idsA = a.tableIds.sort().join(',');
     const idsB = b.tableIds.sort().join(',');
     return idsA.localeCompare(idsB);
   });
   ```

5. **Limited Return**: Returns only the first `limit` candidates (default: 10)

#### Function: `selectBestCandidate`

**Purpose**: Selects the best candidate according to the WokiBrain strategy.

**Implementation**: Simply calls `findCandidates` with `limit=1` and returns the first element or `null`.

#### Function: `generateCombinations`

**Purpose**: Generates all combinations of size k or larger from an array.

**Algorithm**: Uses recursion to generate combinations of all sizes from `minSize` to the array size.

**Example**:
```
Tables: [T1, T2, T3]
minSize: 2

Generated combinations:
- [T1, T2]
- [T1, T3]
- [T2, T3]
- [T1, T2, T3]
```

---

### 5. Booking Service (`src/domain/booking-service.ts`)

#### Function: `createBooking`

**Purpose**: Creates a booking atomically with support for idempotency and locks.

**Complete Flow**:

1. **Idempotency Verification**:
   ```typescript
   if (idempotencyKey) {
     const existing = db.getIdempotency(idempotencyKey);
     if (existing) {
       return existing; // Returns existing booking
     }
   }
   ```

2. **Entity Validation**:
   - Verifies that the restaurant exists
   - Verifies that the sector exists and belongs to the restaurant

3. **Candidate Selection**:
   ```typescript
   const candidate = selectBestCandidate(...);
   if (!candidate) {
     throw new Error('no_capacity');
   }
   ```

4. **Service Window Validation**:
   - If a specific window is requested, verifies that it is within service windows

5. **Lock Acquisition**:
   ```typescript
   const lockKey = lockManager.generateLockKey(...);
   const releaseLock = await lockManager.acquire(lockKey);
   ```

6. **Double-Check Pattern**:
   - After acquiring the lock, verifies again that the candidate is available
   - This prevents race conditions where two requests select the same candidate

7. **Booking Creation**:
   ```typescript
   // B3: Verify if approval is required (large groups)
   const largeGroupThreshold = restaurant.largeGroupThreshold || 10;
   const requiresApproval = partySize >= largeGroupThreshold;
   
   const booking: Booking = {
     id: generateBookingId(),
     restaurantId,
     sectorId,
     tableIds: candidate.tableIds,
     partySize,
     start: candidate.start,
     end: candidate.end,
     durationMinutes,
     status: requiresApproval ? 'PENDING' : 'CONFIRMED', // B3
     createdAt: now,
     updatedAt: now,
   };
   db.createBooking(booking);
   
   // B8: Record metrics
   if (booking.status === 'CONFIRMED') {
     metricsStore.incrementBookingCreated();
   } else {
     metricsStore.incrementBookingPending();
   }
   metricsStore.recordAssignmentTime(assignmentTime);
   ```

8. **Idempotency Storage**:
   ```typescript
   if (idempotencyKey) {
     db.setIdempotency(idempotencyKey, booking, 60);
   }
   ```

9. **Lock Release**:
   ```typescript
   finally {
     releaseLock(); // Always release, even if there is an error
   }
   ```

**Booking ID Generation**:
```typescript
function generateBookingId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 9);
  return `BK_${timestamp}${random}`.toUpperCase();
}
// Example: "BK_MJ0RK1N8PEJSJFV"
```

---

### 6. HTTP Routes (`src/routes.ts`)

#### Request ID Middleware

```typescript
router.use((req, res, next) => {
  (req as any).requestId = `req_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  next();
});
```

**Purpose**: Assigns a unique ID to each request for log traceability.

#### Validation with Zod

The system uses Zod to validate all inputs:

```typescript
const discoverSchema = z.object({
  restaurantId: z.string().min(1),
  sectorId: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  partySize: z.coerce.number().int().positive(),
  duration: z.coerce.number().int().positive().multipleOf(15),
  windowStart: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  windowEnd: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  limit: z.coerce.number().int().positive().max(100).optional().default(10),
});
```

#### Endpoint: `GET /woki/discover`

**Purpose**: Discovers available candidates without creating a booking.

**Process**:
1. Validates parameters with Zod
2. Verifies that restaurant and sector exist
3. Validates that duration is a multiple of 15
4. Validates that the requested window is within service windows
5. Calls `findCandidates`
6. If there are no candidates, returns 409 (no_capacity)
7. Returns list of sorted candidates

**Successful Response (200)**:
```json
{
  "slotMinutes": 15,
  "durationMinutes": 90,
  "candidates": [
    {
      "kind": "single",
      "tableIds": ["T4"],
      "start": "2025-10-22T20:00:00-03:00",
      "end": "2025-10-22T21:30:00-03:00",
      "minCapacity": 4,
      "maxCapacity": 6,
      "score": 1234,
      "rationale": "single table, capacity: 4-6, 1 seat spare"
    },
    {
      "kind": "combo",
      "tableIds": ["T2", "T3"],
      "start": "2025-10-22T20:15:00-03:00",
      "end": "2025-10-22T21:45:00-03:00",
      "minCapacity": 4,
      "maxCapacity": 8,
      "score": 2234,
      "rationale": "2-table combo, capacity: 4-8, 3 seats spare"
    }
  ]
}
```

**Note**: The `score` and `rationale` fields provide information about how WokiBrain selects candidates. The score is a number (lower is better) and the rationale is a human-readable explanation.

#### Endpoint: `POST /woki/bookings`

**Purpose**: Creates a booking atomically.

**Headers**:
- `Idempotency-Key` (optional): Key for idempotency

**Body**:
```json
{
  "restaurantId": "R1",
  "sectorId": "S1",
  "partySize": 5,
  "durationMinutes": 90,  // Optional: B1 - Automatically calculated if omitted
  "date": "2025-10-22",
  "windowStart": "20:00",
  "windowEnd": "23:45"
}
```

**B1 - Variable Duration by Party Size**: If `durationMinutes` is omitted, it is automatically calculated based on group size:
- ≤2 people → 75 minutes
- ≤4 people → 90 minutes
- ≤8 people → 120 minutes
- >8 people → 150 minutes

**Process**:
1. Validates body with Zod
2. Extracts `Idempotency-Key` from header
3. Calls `createBooking`
4. Returns the created booking

**Successful Response (201)**:
```json
{
  "id": "BK_MJ0RK1N8PEJSJFV",
  "restaurantId": "R1",
  "sectorId": "S1",
  "tableIds": ["T4"],
  "partySize": 5,
  "start": "2025-10-22T20:00:00-03:00",
  "end": "2025-10-22T21:30:00-03:00",
  "durationMinutes": 90,
  "status": "CONFIRMED",
  "createdAt": "2025-10-22T19:50:21-03:00",
  "updatedAt": "2025-10-22T19:50:21-03:00"
}
```

#### Endpoint: `GET /woki/bookings/day`

**Purpose**: Lists all confirmed bookings for a specific day.

**Query Parameters**:
- `restaurantId` (required)
- `sectorId` (required)
- `date` (required, format YYYY-MM-DD)

**Response (200)**:
```json
{
  "date": "2025-10-22",
  "items": [
    {
      "id": "BK_001",
      "tableIds": ["T4"],
      "partySize": 5,
      "start": "2025-10-22T20:00:00-03:00",
      "end": "2025-10-22T21:30:00-03:00",
      "status": "CONFIRMED"
    }
  ]
}
```

#### Endpoint: `DELETE /woki/bookings/:id` (Bonus)

**Purpose**: Deletes a booking, immediately freeing the slot. Automatically attempts to promote waitlist entries if capacity is available.

**Response**: 204 No Content

#### Endpoint: `POST /woki/bookings/:id/approve` (B3 - Large-Group Approval)

**Purpose**: Approves a PENDING booking and converts it to CONFIRMED.

**Successful Response (200)**: Returns the updated booking with `status: "CONFIRMED"`

#### Endpoint: `POST /woki/bookings/:id/reject` (B3 - Large-Group Approval)

**Purpose**: Rejects a PENDING booking and deletes it.

**Response**: 204 No Content

#### Endpoint: `POST /woki/blackouts` (B4 - Blackouts)

**Purpose**: Creates a blocking period for a table (maintenance, private events, etc.).

**Body**:
```json
{
  "tableId": "T4",
  "start": "2025-10-22T20:00:00-03:00",
  "end": "2025-10-22T22:00:00-03:00",
  "reason": "Maintenance"
}
```

**Successful Response (201)**: Returns the created blackout

#### Endpoint: `GET /woki/blackouts` (B4 - Blackouts)

**Purpose**: Lists blackouts. Optional filters: `tableId`, `date`.

**Query Parameters**:
- `tableId` (optional): Filter by specific table
- `date` (optional, format YYYY-MM-DD): Filter by date

**Response (200)**:
```json
{
  "items": [
    {
      "id": "BL_...",
      "tableId": "T4",
      "start": "2025-10-22T20:00:00-03:00",
      "end": "2025-10-22T22:00:00-03:00",
      "reason": "Maintenance",
      "createdAt": "...",
      "updatedAt": "..."
    }
  ]
}
```

#### Endpoint: `DELETE /woki/blackouts/:id` (B4 - Blackouts)

**Purpose**: Deletes a blackout.

**Response**: 204 No Content

#### Endpoint: `GET /woki/waitlist` (B5 - Waitlist)

**Purpose**: Lists waitlist entries for a sector and date.

**Query Parameters**:
- `sectorId` (required)
- `date` (required, format YYYY-MM-DD)

**Response (200)**:
```json
{
  "items": [
    {
      "id": "WL_...",
      "restaurantId": "R1",
      "sectorId": "S1",
      "partySize": 5,
      "durationMinutes": 90,
      "date": "2025-10-22",
      "windowStart": "20:00",
      "windowEnd": "23:45",
      "createdAt": "...",
      "expiresAt": "..."
    }
  ]
}
```

#### Endpoint: `DELETE /woki/waitlist/:id` (B5 - Waitlist)

**Purpose**: Removes a waitlist entry.

**Response**: 204 No Content

#### Endpoint: `POST /woki/waitlist/cleanup` (B5 - Waitlist)

**Purpose**: Cleans expired waitlist entries.

**Response (200)**:
```json
{
  "cleaned": 5
}
```

#### Endpoint: `GET /woki/metrics` (B8 - Observability)

**Purpose**: Gets system metrics.

**Response (200)**:
```json
{
  "bookings": {
    "created": 150,
    "cancelled": 10,
    "conflicts": 5,
    "pending": 3,
    "confirmed": 147
  },
  "performance": {
    "p95AssignmentTime": 45,
    "avgAssignmentTime": 32
  },
  "locks": {
    "acquisitions": 200,
    "contentions": 8
  },
  "waitlist": {
    "entries": 12,
    "promotions": 7
  }
}
```

#### Error Handling

```typescript
function handleError(err, req, res, next) {
  const errorName = err.message;
  
  if (errorName === 'not_found') {
    return res.status(404).json({ error: 'not_found', ... });
  }
  if (errorName === 'no_capacity') {
    return res.status(409).json({ error: 'no_capacity', ... });
  }
  if (errorName === 'outside_service_window') {
    return res.status(422).json({ error: 'outside_service_window', ... });
  }
  if (errorName === 'invalid_input') {
    return res.status(400).json({ error: 'invalid_input', ... });
  }
  
  // Internal error
  res.status(500).json({ error: 'internal_error', ... });
}
```

**HTTP Codes**:
- `200`: Success (GET)
- `201`: Created (POST)
- `204`: No Content (DELETE)
- `400`: Bad Request (validation failed)
- `404`: Not Found (restaurant/sector does not exist)
- `409`: Conflict (no capacity) - Note: With implicit waitlist, may return 201 with status PENDING
- `422`: Unprocessable Entity (window outside service)
- `500`: Internal Server Error

**Logging Behavior**:
- **Validation errors (4xx)**: Logged as `VALIDATION (expected)` with level `warn`. These are expected business logic validations (e.g., no capacity, outside service window, invalid input) and are part of normal application flow, not system errors.
- **System errors (5xx)**: Logged as `ERROR` with level `error`. These indicate unexpected system failures that require attention.

---

### 7. Main Server (`src/index.ts`)

#### Configuration

```typescript
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());  // Parse JSON bodies
app.use(routes);          // Mounts routes
app.use(errorHandler);   // Global error handling
```

#### Health Check

```typescript
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});
```

#### Seed Data

In development mode, automatically loads sample data:
- 1 restaurant (R1)
- 1 sector (S1)
- 5 tables (T1-T5)
- 1 example booking (B1)

#### Server Startup

```typescript
if (!process.env.VITEST) {
  app.listen(PORT, () => {
    logger.info(`WokiBrain server running on port ${PORT}`);
  });
}
```

The server does not start in test mode to avoid port conflicts.

---

## Data Flow

### Discovery Flow (GET /woki/discover)

```
1. HTTP Request → routes.ts
2. Zod Validation → discoverSchema.parse()
3. B1: If duration is not provided → calculateDurationByPartySize()
4. Entity verification → db.getRestaurant(), db.getSector()
5. Candidate search → findCandidates()
   ├─ findTableGaps() for each individual table
   │  └─ B4: filterGapsByBlackouts() excludes blocked periods
   ├─ filterGapsByDuration() for each gap
   ├─ generateCombinations() for combos
   ├─ findComboGaps() for each combo
   │  └─ B4: filterGapsByBlackouts() excludes blocked periods
   ├─ Score and rationale calculation for each candidate
   └─ Sorting according to WokiBrain strategy
6. JSON Response → Client (includes score, rationale, capacities)
```

### Booking Creation Flow (POST /woki/bookings)

```
1. HTTP Request → routes.ts
2. Zod Validation → createBookingSchema.parse()
3. B1: If durationMinutes is not provided → calculateDurationByPartySize()
4. Idempotency verification → db.getIdempotency()
5. Candidate selection → selectBestCandidate()
6. If there is no candidate:
   - B5: Add to waitlist (implicit waitlist)
   - Create PENDING booking with placeholder times
   - Return 201 with status PENDING
7. If there is a candidate:
   - Lock acquisition → lockManager.acquire()
   - B8: Record lock acquisition time
   - Double-check → Availability verification
   - B3: Verify if partySize >= threshold → create PENDING or CONFIRMED
   - Booking creation → db.createBooking()
   - B8: Record metrics (created/pending, assignment time)
   - Idempotency storage → db.setIdempotency()
   - Lock release → releaseLock()
8. JSON Response → Client
```

---

## Key Algorithms

### 1. Gap Intersection Algorithm

**Problem**: Finding intervals where multiple tables are simultaneously free.

**Solution**: Two-pointer algorithm (two-pointer technique)

```typescript
function intersectGaps(gaps1: Gap[], gaps2: Gap[]): Gap[] {
  const result: Gap[] = [];
  let i = 0, j = 0;
  
  while (i < gaps1.length && j < gaps2.length) {
    const gap1 = gaps1[i];
    const gap2 = gaps2[j];
    
    // Find overlap
    const overlapStart = max(gap1.start, gap2.start);
    const overlapEnd = min(gap1.end, gap2.end);
    
    if (overlapStart < overlapEnd) {
      result.push({ start: overlapStart, end: overlapEnd });
    }
    
    // Advance the pointer of the gap that ends first
    if (gap1.end < gap2.end) {
      i++;
    } else {
      j++;
    }
  }
  
  return result;
}
```

**Complexity**: O(n + m) where n and m are the array sizes.

### 2. Combination Generation Algorithm

**Problem**: Generating all combinations of size k or larger from an array.

**Solution**: Recursion with backtracking

```typescript
function generateCombinations<T>(arr: T[], minSize: number): T[][] {
  const combinations: T[][] = [];
  
  function combine(start: number, targetSize: number, combo: T[]) {
    if (combo.length === targetSize) {
      combinations.push([...combo]);
      return;
    }
    
    for (let i = start; i < arr.length; i++) {
      combo.push(arr[i]);
      combine(i + 1, targetSize, combo);
      combo.pop(); // Backtrack
    }
  }
  
  for (let size = minSize; size <= arr.length; size++) {
    combine(0, size, []);
  }
  
  return combinations;
}
```

**Complexity**: O(2^n) in worst case, but limited to combinations of 2+ tables.

### 3. Slot Rounding Algorithm

**Problem**: Rounding times to 15-minute intervals.

**Solution**:
```typescript
function roundToSlot(date: Date, slotMinutes: number, direction: 'up' | 'down'): Date {
  const minutes = date.getMinutes();
  const remainder = minutes % slotMinutes;
  
  if (remainder === 0) return new Date(date);
  
  const rounded = new Date(date);
  if (direction === 'up') {
    rounded.setMinutes(minutes + (slotMinutes - remainder));
  } else {
    rounded.setMinutes(minutes - remainder);
  }
  rounded.setSeconds(0);
  rounded.setMilliseconds(0);
  
  return rounded;
}
```

---

## Concurrency Handling

### Race Condition Problem

**Scenario**: Two simultaneous requests try to book the same slot.

**Solution**: Promise-based lock system

```typescript
// Request 1
const release1 = await lockManager.acquire("R1:S1:T4:20:00");
// ... creates booking ...
release1();

// Request 2 (arrives simultaneously)
const release2 = await lockManager.acquire("R1:S1:T4:20:00");
// Waits until Request 1 releases the lock
// ... verifies availability (double-check) ...
// If already occupied, returns 409
```

### Double-Check Pattern

After acquiring the lock, availability is verified again:

```typescript
const releaseLock = await lockManager.acquire(lockKey);

try {
  // Double-check: verify that the candidate is still available
  const conflictingBookings = db.getBookingsByTablesAndDate(...);
  const hasConflict = conflictingBookings.some(...);
  
  if (hasConflict) {
    throw new Error('no_capacity');
  }
  
  // Create booking
  db.createBooking(booking);
} finally {
  releaseLock();
}
```

This prevents two requests that select the same candidate from both creating bookings.

---

## Usage Examples

### Example 1: Discover Availability

**Request**:
```bash
GET /woki/discover?restaurantId=R1&sectorId=S1&date=2025-10-22&partySize=5&duration=90&windowStart=20:00&windowEnd=23:45
```

**Internal Process**:
1. Validates that R1 and S1 exist
2. Finds all tables in S1
3. For each table that fits 5 people:
   - Searches for available gaps
   - Filters by duration of 90 minutes
   - Filters by window 20:00-23:45
4. Generates table combinations
5. Finds combo gaps
6. Sorts according to WokiBrain strategy
7. Returns top 10 candidates

**Response**:
```json
{
  "slotMinutes": 15,
  "durationMinutes": 90,
  "candidates": [
    {
      "kind": "single",
      "tableIds": ["T4"],
      "start": "2025-10-22T20:00:00-03:00",
      "end": "2025-10-22T21:30:00-03:00"
    }
  ]
}
```

### Example 2: Create Booking with Idempotency

**Request 1**:
```bash
POST /woki/bookings
Headers: Idempotency-Key: abc-123
Body: { "restaurantId": "R1", "sectorId": "S1", "partySize": 5, ... }
```

**Process**:
1. Verifies idempotency → does not exist
2. Selects candidate → T4 at 20:00
3. Acquires lock
4. Creates booking BK_001
5. Stores in idempotency cache
6. Returns BK_001

**Request 2** (same Idempotency-Key):
```bash
POST /woki/bookings
Headers: Idempotency-Key: abc-123
Body: { "restaurantId": "R1", "sectorId": "S1", "partySize": 5, ... }
```

**Process**:
1. Verifies idempotency → finds BK_001
2. Returns BK_001 immediately (without creating new booking)

### Example 3: Booking with Table Combination

**Request**:
```bash
POST /woki/bookings
Body: { "restaurantId": "R1", "sectorId": "S1", "partySize": 7, ... }
```

**Process**:
1. Searches individual tables → none fit 7 people
2. Generates combinations:
   - T2 + T3: capacity 4-8 ✓
   - T1 + T4: capacity 6-8 ✓
   - T2 + T4: capacity 6-10 ✓
3. Finds gaps for each combo
4. Selects best option according to WokiBrain
5. Creates booking with `tableIds: ["T2", "T3"]`

---

## Design Considerations

### 1. Intervals [start, end)

Intervals are **semi-open**: `[start, end)` where `end` is exclusive.

**Advantage**: Allows bookings to touch without conflict:
- Booking 1: [20:00, 21:30)
- Booking 2: [21:30, 22:30) ✓ Valid

### 2. 15-Minute Grid

All bookings are aligned to 15-minute intervals:
- 20:00, 20:15, 20:30, 20:45, etc.

**Advantage**: Simplifies the logic and makes the system more predictable.

### 3. In-Memory Persistence

The database uses JavaScript `Map`, so:
- ✅ Very fast for development and testing
- ✅ Does not require database configuration
- ❌ Data is lost when the server restarts
- ❌ Not scalable for production

**For production**: Replace with PostgreSQL, MongoDB, etc.

### 4. Deterministic WokiBrain Strategy

The selection strategy always returns the same result for the same inputs:
1. Individual tables first
2. Earliest time
3. Minimum waste
4. Ordering by IDs

**Advantage**: Predictable and testable behavior.

---

## Testing

### Unit Tests

**File**: `src/tests/wokibrain.spec.ts`

Covers:
- **Happy path: individual table**: Finds a perfect gap in an individual table for the requested duration
- **Happy path: table combination**: Finds a valid combination when individual tables cannot accommodate the group
- **Boundary conditions: touching bookings**: Verifies that bookings ending exactly when another starts are valid (end-exclusive)
- **Determinism**: Verifies that the same input always produces the same output

### Integration Tests

**File**: `src/tests/api.spec.ts`

Covers the following scenarios:

#### GET /woki/discover
- **Success**: Returns available candidates correctly
- **No capacity (409)**: 
  - Creates a long booking (210 minutes) that occupies almost the entire window (20:00-23:45 = 225 minutes)
  - Leaves only 15 minutes free, insufficient for a 90-minute booking
  - Verifies that it returns 409 with error `no_capacity`
- **Outside service window (422)**: Verifies that windows outside service hours return 422

#### POST /woki/bookings
- **Success**: Creates a booking correctly with duration of 90 minutes (according to requirements)
- **Idempotency**: 
  - Two requests with the same `Idempotency-Key` return the same booking
  - Verifies that no duplicate bookings are created
- **Concurrency**: 
  - Two simultaneous requests trying to book the same slot
  - One must succeed (201) and the other must fail (409)
- **Outside service window (422)**: Validates that windows outside service return 422

#### GET /woki/bookings/day
- Correctly lists all confirmed bookings for a day

**Note on durations in tests**:
- The requirements specify `duration=90` minutes as standard example
- The "no capacity" test intentionally uses `durationMinutes: 210` to occupy almost the entire time window (225 minutes), leaving only 15 minutes free which are insufficient for a 90-minute booking
- This allows correctly testing the 409 error case when there is no available capacity

---

**Document Version**: 2.0  
**Date**: December 2025  
**Author**: Hernan Abeldaño  
**Update**: Includes implemented bonus features (Score/Rationale, B1, B3, B4, B5, B8)