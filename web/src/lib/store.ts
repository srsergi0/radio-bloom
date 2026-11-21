// Mini store observable compartido entre islas (mismo módulo = misma instancia)
import { useSyncExternalStore } from "react";

export interface Store<T> {
  get: () => T;
  /** Estado inicial: lo que se renderizó en el HTML estático (para hidratar sin desajustes) */
  initial: T;
  set: (patch: Partial<T> | ((s: T) => Partial<T>)) => void;
  subscribe: (fn: () => void) => () => void;
}

export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial;
  const subs = new Set<() => void>();
  return {
    initial,
    get: () => state,
    set(patch) {
      const p = typeof patch === "function" ? patch(state) : patch;
      state = { ...state, ...p };
      for (const fn of subs) fn();
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

export function useStore<T extends object>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, () => store.initial);
}
