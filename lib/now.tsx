"use client";

import { createContext, useContext, useState, useSyncExternalStore, type ReactNode } from "react";

type NowStore = {
  initial: number;
  get: () => number;
  subscribe: (listener: () => void) => () => void;
};

function createNowStore(initial: number): NowStore {
  let now = initial;
  const listeners = new Set<() => void>();
  let timer: number | null = null;
  const tick = () => {
    now = Date.now();
    for (const listener of listeners) listener();
  };
  return {
    initial,
    get: () => now,
    subscribe(listener) {
      listeners.add(listener);
      if (timer == null) {
        tick();
        timer = window.setInterval(tick, 1000);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && timer != null) {
          window.clearInterval(timer);
          timer = null;
        }
      };
    },
  };
}

const NowContext = createContext<NowStore | null>(null);

/**
 * One shared one-second clock. Only the components that read it re-render each second,
 * so the tables are not reformatted on every tick.
 */
export function NowProvider({ initial, children }: { initial: number; children: ReactNode }) {
  const [store] = useState(() => createNowStore(initial));
  return <NowContext.Provider value={store}>{children}</NowContext.Provider>;
}

export function useNow(): number {
  const store = useContext(NowContext);
  if (!store) throw new Error("useNow fuera de NowProvider");
  return useSyncExternalStore(store.subscribe, store.get, () => store.initial);
}

/** Re-renders only when the selected primitive changes (for example, the start of the UTC week). */
export function useNowSelect<T extends string | number>(select: (now: number) => T): T {
  const store = useContext(NowContext);
  if (!store) throw new Error("useNowSelect fuera de NowProvider");
  return useSyncExternalStore(
    store.subscribe,
    () => select(store.get()),
    () => select(store.initial),
  );
}
