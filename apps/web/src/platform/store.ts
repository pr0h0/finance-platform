// The local database for a store name: IndexedDB in the browser, SQLite (through the Tauri shell)
// in the native app. One instance per name, so every part of the app sees the same data.
import { IdbStore, type LocalStore } from '@finplat/storage';
import { isNative, nativeStore } from './native.ts';

const open = new Map<string, LocalStore>();

export function openStore(name: string): LocalStore {
  let s = open.get(name);
  if (!s) {
    s = isNative ? nativeStore(name) : new IdbStore(name);
    open.set(name, s);
  }
  return s;
}
