// Sync protocol v1 wire types. Spec: docs/architecture/sync-protocol.md

import type { IsoInstant, Uuid } from './entities.ts';
import type { SyncOp } from './enums.ts';

export const SYNC_PROTOCOL_VERSION = 1;

/** A client-side operation, created offline and pushed later. Idempotent by opId. */
export interface SyncOperation {
  opId: Uuid; // UUIDv7 generated on the device
  entityType: string; // table name, e.g. "transactions"
  entityId: Uuid;
  op: SyncOp;
  baseVersion: number | null; // entity `version` the edit was based on (null = create)
  data: Record<string, unknown> | null; // full entity (upsert) or null (delete)
  changedFields?: string[]; // fields the user changed relative to baseVersion (for merge)
  clientTime: IsoInstant;
}

export interface PushRequest {
  protocolVersion: number;
  deviceId: Uuid;
  profileId: Uuid;
  operations: SyncOperation[]; // ≤ 500 per request, applied in order
}

export type OperationResult =
  | { opId: Uuid; status: 'applied'; serverVersion: number; version: number }
  | { opId: Uuid; status: 'conflict'; conflictId: Uuid; fields: string[] }
  | { opId: Uuid; status: 'rejected'; code: string; message: string };

export interface PushResponse {
  results: OperationResult[];
  serverVersion: number; // profile head after the push
}

export interface SyncChange {
  serverVersion: number;
  entityType: string;
  entityId: Uuid;
  op: SyncOp;
  data: Record<string, unknown> | null;
  opId: Uuid | null;
  deviceId: Uuid | null;
  changedAt: IsoInstant;
}

export interface PullResponse {
  changes: SyncChange[]; // ascending serverVersion, all > `since`
  nextSince: number; // pass back as ?since=
  hasMore: boolean;
  serverVersion: number; // profile head
}

export interface SyncConflict {
  id: Uuid;
  entityType: string;
  entityId: Uuid;
  opId: Uuid;
  baseVersion: number;
  fields: string[];
  serverData: Record<string, unknown>;
  clientData: Record<string, unknown>;
  status: 'open' | 'resolved' | 'dismissed';
  createdAt: IsoInstant;
}
