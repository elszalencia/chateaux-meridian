// DemoProvider: the demo clock, reset, error switch and a `version` counter that every view puts in
// its load dependencies, so one click on the demo bar refreshes all three views.

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { CorridorId, DemoState } from '@casa-puente/services';
import { api, clearPersistedDemo } from './api';

// Presenter corridor: picks which office views the nav lists and which buyer opens by default.
// Presentation chrome only; every product screen takes its corridor from the plan it shows.
const CORRIDOR_KEY = 'chateaux-demo-corridor';

function readCorridor(): CorridorId {
  try {
    return window.localStorage.getItem(CORRIDOR_KEY) === 'sv' ? 'sv' : 'co';
  } catch {
    return 'co';
  }
}

interface DemoValue {
  state: DemoState | null;
  version: number;
  busy: boolean;
  lastResetMs: number | null;
  /** Presenter corridor (demo bar switch). */
  corridor: CorridorId;
  setCorridor: (c: CorridorId) => void;
  refresh: () => Promise<void>;
  advanceMonth: () => Promise<void>;
  reset: () => Promise<number>;
  setErrorMode: (on: boolean) => Promise<void>;
  setPassThrough: (p: number) => Promise<void>;
}

const DemoContext = createContext<DemoValue | null>(null);

export function DemoProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DemoState | null>(null);
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [lastResetMs, setLastResetMs] = useState<number | null>(null);
  const [corridor, setCorridorState] = useState<CorridorId>(readCorridor);
  const setCorridor = useCallback((c: CorridorId) => {
    setCorridorState(c);
    try {
      window.localStorage.setItem(CORRIDOR_KEY, c);
    } catch {
      // ignore
    }
  }, []);

  const refresh = useCallback(async () => {
    setState(await api.getDemoState());
    setVersion((v) => v + 1);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const advanceMonth = useCallback(async () => {
    setBusy(true);
    try {
      setState(await api.advanceClock(1));
      setVersion((v) => v + 1);
    } finally {
      setBusy(false);
    }
  }, []);

  const reset = useCallback(async () => {
    setBusy(true);
    const t0 = performance.now();
    try {
      clearPersistedDemo();
      const { state: s } = await api.reset();
      setState(s);
      setVersion((v) => v + 1);
      const elapsed = Math.round(performance.now() - t0);
      setLastResetMs(elapsed);
      return elapsed;
    } finally {
      setBusy(false);
    }
  }, []);

  const setErrorMode = useCallback(async (on: boolean) => {
    setState(await api.setErrorMode(on));
    setVersion((v) => v + 1);
  }, []);

  const setPassThrough = useCallback(async (p: number) => {
    setState(await api.setPassThrough(p));
    setVersion((v) => v + 1);
  }, []);

  const value = useMemo<DemoValue>(
    () => ({ state, version, busy, lastResetMs, corridor, setCorridor, refresh, advanceMonth, reset, setErrorMode, setPassThrough }),
    [state, version, busy, lastResetMs, corridor, setCorridor, refresh, advanceMonth, reset, setErrorMode, setPassThrough],
  );
  return <DemoContext.Provider value={value}>{children}</DemoContext.Provider>;
}

export function useDemo(): DemoValue {
  const ctx = useContext(DemoContext);
  if (!ctx) throw new Error('useDemo outside DemoProvider');
  return ctx;
}
