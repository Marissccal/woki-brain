export type ISODateTime = string;

export interface Restaurant {
  id: string;
  name: string;
  timezone: string;
  windows?: Array<{ start: string; end: string }>;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface Sector {
  id: string;
  restaurantId: string;
  name: string;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface Table {
  id: string;
  sectorId: string;
  name: string;
  minSize: number;
  maxSize: number;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export type BookingStatus = 'CONFIRMED' | 'CANCELLED' | 'PENDING';

export interface Booking {
  id: string;
  restaurantId: string;
  sectorId: string;
  tableIds: string[]; // single or combo (any length)
  partySize: number;
  start: ISODateTime; // [start,end)
  end: ISODateTime;
  durationMinutes: number;
  status: BookingStatus;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface Gap {
  start: ISODateTime;
  end: ISODateTime;
}

export interface Candidate {
  kind: 'single' | 'combo';
  tableIds: string[];
  start: ISODateTime;
  end: ISODateTime;
  minCapacity?: number;
  maxCapacity?: number;
  score?: number; // WokiBrain score (lower is better)
  rationale?: string; // Human-readable explanation of selection
}

