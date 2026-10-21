// Global shell UI state. Other pages can open the quick-add dialog or the palette:
//   useShell.getState().openQuickAdd('income')
import { create } from 'zustand';

export type QuickKind = 'expense' | 'income' | 'transfer';

interface ShellState {
  palette: boolean;
  quickAdd: QuickKind | null;
  openPalette: () => void;
  closePalette: () => void;
  openQuickAdd: (k?: QuickKind) => void;
  closeQuickAdd: () => void;
}

export const useShell = create<ShellState>((set) => ({
  palette: false,
  quickAdd: null,
  openPalette: () => set({ palette: true }),
  closePalette: () => set({ palette: false }),
  openQuickAdd: (k = 'expense') => set({ quickAdd: k, palette: false }),
  closeQuickAdd: () => set({ quickAdd: null }),
}));
