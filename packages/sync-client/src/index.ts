// Sync engine for clients (protocol: docs/architecture/sync-protocol.md). Implementation is
// owned by the sync agent; wire types live in @finplat/domain.
export type {
  PullResponse,
  PushRequest,
  PushResponse,
  SyncChange,
  SyncOperation,
} from '@finplat/domain';
export { SYNC_PROTOCOL_VERSION } from '@finplat/domain';
export type { LocalStore } from '@finplat/storage';
