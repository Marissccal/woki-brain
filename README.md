# WokiBrain

A compact restaurant booking engine that discovers **when** and **how** to seat a party using single tables or table combinations.

## Features

### Core Features
- Gap discovery for single tables and combinations
- Deterministic WokiBrain selection strategy
- Atomic booking creation with locking
- Idempotency support
- Service window enforcement
- 15-minute time grid

### Bonus Features Implemented
- ✅ **Score/Rationale in API**: Candidates include selection score and human-readable rationale
- ✅ **Variable Duration by Party Size**: Automatic duration calculation based on party size
- ✅ **Large-Group Approval**: PENDING status for large groups requiring approval
- ✅ **Blackouts**: Block time periods for maintenance or private events
- ✅ **Waitlist with Auto-Promotion**: Automatic waitlist when no capacity, with auto-promotion
- ✅ **Observability**: System metrics endpoint with counters and performance stats

## Combo Capacity Heuristic

**Simple Sum Approach**: For any combination of tables, the capacity range is calculated as:
- `minCapacity = sum of all table minSizes`
- `maxCapacity = sum of all table maxSizes`

This approach is simple, predictable, and allows maximum flexibility for seating parties across combined tables.

## WokiBrain Selection Strategy

The selection strategy prioritizes candidates in the following order:

1. **Single tables first**: Prefer single table solutions over combinations
2. **Earliest start time**: Among candidates of the same kind, choose the earliest available slot
3. **Minimum waste**: For ties, prefer the table/combo with the smallest capacity that still fits the party
4. **Deterministic ordering**: When all else is equal, sort by table IDs lexicographically

This strategy optimizes for simplicity (single tables), efficiency (earliest booking), and resource utilization (minimal waste).

## Getting Started

### Prerequisites

- Node.js (v18 or higher recommended)
- npm (v9 or higher)

### Install Dependencies

```bash
npm install
```

### Development

Start the development server with hot reload:

```bash
npm run dev
```

The server will start on `http://localhost:3000` by default.

### Build

Build the TypeScript project:

```bash
npm run build
```

Start the production server:

```bash
npm start
```

### Testing

Run all tests:

```bash
npm test
```

Run tests in watch mode:

```bash
npm run test:watch
```

Run tests once (non-watch):

```bash
npm test -- --run
```

#### Test Coverage

The project includes:
- **Unit tests**: `src/tests/wokibrain.spec.ts` - Core logic tests
- **Integration tests**: `src/tests/api.spec.ts` - API endpoint tests
- **Bonus features tests**: `src/tests/bonus.spec.ts` - Bonus features tests

### Manual API Testing

Use the provided shell script to test all endpoints manually:

```bash
# Make sure the server is running first
npm run dev

# In another terminal, run the test script
./test-api.sh
```

The script requires `curl` and `jq` to be installed.

## API Endpoints

### Core Endpoints

#### 1. Discover Seats

`GET /woki/discover`

Query parameters:
- `restaurantId` (required)
- `sectorId` (required)
- `date` (required, YYYY-MM-DD)
- `partySize` (required)
- `duration` (optional, minutes - auto-calculated if omitted)
- `windowStart` (optional, HH:mm)
- `windowEnd` (optional, HH:mm)
- `limit` (optional, default: 10)

**Response includes**:
- `candidates`: Array of available options with `score`, `rationale`, `minCapacity`, `maxCapacity`
- `slotMinutes`: 15 (time grid)
- `durationMinutes`: Requested or calculated duration

**Example**:
```bash
curl "http://localhost:3000/woki/discover?restaurantId=R1&sectorId=S1&date=2025-10-22&partySize=5&duration=90&windowStart=20:00&windowEnd=23:45"
```

#### 2. Create Booking

`POST /woki/bookings`

Headers:
- `Idempotency-Key` (optional but recommended)

Body:
```json
{
  "restaurantId": "R1",
  "sectorId": "S1",
  "partySize": 5,
  "durationMinutes": 90,  // Optional: auto-calculated if omitted
  "date": "2025-10-22",
  "windowStart": "20:00",
  "windowEnd": "23:45"
}
```

**Note**: `durationMinutes` is optional. If omitted, it's automatically calculated based on party size:
- ≤2 people → 75 minutes
- ≤4 people → 90 minutes
- ≤8 people → 120 minutes
- >8 people → 150 minutes

**Response**: Returns booking with `status: 'CONFIRMED'` or `status: 'PENDING'` (for large groups)

#### 3. List Day Bookings

`GET /woki/bookings/day`

Query parameters:
- `restaurantId` (required)
- `sectorId` (required)
- `date` (required, YYYY-MM-DD)

#### 4. Delete Booking

`DELETE /woki/bookings/:id`

Deletes a booking and automatically attempts to promote waitlist entries.

### Bonus Features Endpoints

#### Large-Group Approval (B3)

**Approve Booking**
```
POST /woki/bookings/:id/approve
```
Converts a PENDING booking to CONFIRMED.

**Reject Booking**
```
POST /woki/bookings/:id/reject
```
Rejects and deletes a PENDING booking.

#### Blackouts (B4)

**Create Blackout**
```
POST /woki/blackouts
```
Body:
```json
{
  "tableId": "T4",
  "start": "2025-10-22T20:00:00-03:00",
  "end": "2025-10-22T22:00:00-03:00",
  "reason": "Maintenance"
}
```

**List Blackouts**
```
GET /woki/blackouts?tableId=T4&date=2025-10-22
```

**Delete Blackout**
```
DELETE /woki/blackouts/:id
```

#### Waitlist (B5)

**List Waitlist**
```
GET /woki/waitlist?sectorId=S1&date=2025-10-22
```

**Remove from Waitlist**
```
DELETE /woki/waitlist/:id
```

**Cleanup Expired Entries**
```
POST /woki/waitlist/cleanup
```

#### Observability (B8)

**Get Metrics**
```
GET /woki/metrics
```

Returns system metrics including:
- Bookings: created, cancelled, conflicts, pending, confirmed
- Performance: P95 and average assignment times
- Locks: acquisitions and contentions
- Waitlist: entries and promotions

**Logging**:
- Validation errors (4xx) are logged as `VALIDATION (expected)` - these are expected business validations (no capacity, outside service window, etc.) and are part of normal application flow.
- System errors (5xx) are logged as `ERROR` - these indicate unexpected system failures.

### Health Check

```
GET /health
```

Returns `{ "status": "ok" }`

## Examples

### Example 1: Discover Available Seats

```bash
curl "http://localhost:3000/woki/discover?restaurantId=R1&sectorId=S1&date=2025-10-22&partySize=5&duration=90&windowStart=20:00&windowEnd=23:45"
```

### Example 2: Create Booking with Auto-Duration

```bash
curl -X POST http://localhost:3000/woki/bookings \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: abc-123" \
  -d '{
    "restaurantId": "R1",
    "sectorId": "S1",
    "partySize": 3,
    "date": "2025-10-22",
    "windowStart": "20:00",
    "windowEnd": "23:45"
  }'
```

Note: `durationMinutes` is omitted, so it will be auto-calculated (90 minutes for 3 people).

### Example 3: Create Blackout

```bash
curl -X POST http://localhost:3000/woki/blackouts \
  -H "Content-Type: application/json" \
  -d '{
    "tableId": "T4",
    "start": "2025-10-22T20:00:00-03:00",
    "end": "2025-10-22T22:00:00-03:00",
    "reason": "Private event"
  }'
```

### Example 4: Get System Metrics

```bash
curl http://localhost:3000/woki/metrics
```

## Technical Stack

- **Runtime**: Node.js + TypeScript
- **Framework**: Express.js
- **Validation**: Zod
- **Logging**: Pino
- **Testing**: Vitest + Supertest
- **Storage**: In-memory (Map-based)

## Project Structure

```
src/
├── index.ts                 # Server entry point
├── routes.ts                # API routes
├── middleware/              # Custom middleware
│   └── error-handler.ts    # Error handling
├── domain/                  # Business logic
│   ├── types.ts            # TypeScript interfaces
│   ├── gaps.ts             # Gap discovery algorithms
│   ├── wokibrain.ts        # Selection strategy
│   ├── booking-service.ts  # Booking operations
│   ├── duration-rules.ts   # B1: Duration calculation
│   ├── blackouts.ts        # B4: Blackout management
│   └── waitlist.ts         # B5: Waitlist management
├── store/                   # Data persistence
│   ├── db.ts               # In-memory database
│   ├── locks.ts            # Concurrency locks
│   └── metrics.ts          # B8: Metrics storage
└── tests/                   # Test files
    ├── api.spec.ts         # API integration tests
    ├── wokibrain.spec.ts   # Core logic tests
    └── bonus.spec.ts       # Bonus features tests
```

## Documentation

- **Technical Documentation**: See `WOKIBRAIN_DOCUMENTATION.md` for detailed technical documentation
- **Requirements Checklist**: See `REQUIREMENTS_CHECKLIST.md` for requirements coverage
- **Bonus Features Changelog**: See `BONUS_FEATURES_CHANGELOG.md` for bonus features details
