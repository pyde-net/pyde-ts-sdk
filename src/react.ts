/**
 * React hooks for pyde-ts-sdk.
 *
 * Sub-entry: `import { PydeProvider, useBalance, ... } from "pyde-ts-sdk/react"`.
 *
 * What's here:
 *   - `<PydeProvider>` — context provider. Wrap your app with one.
 *   - `usePydeProvider()` / `usePydeWebSocket()` / `usePydeSigner()` —
 *     escape-hatch accessors for direct SDK use.
 *   - Per-domain hooks: `useBalance`, `useAccount`, `useNonce`,
 *     `useWave`, `useContract`, `useEvent`.
 *
 * SSR safety:
 *   - All hooks read state via `useState` and never touch `window` /
 *     `WebSocket` during render. The WebSocket connection is opened in
 *     `useEffect`, which doesn't run on the server.
 *   - The provider memoises both the HTTP `Provider` and the optional
 *     `WebSocketProvider`; rerenders that change `rpcUrl` / `wsUrl`
 *     cleanly tear down the previous WS connection before opening the
 *     next.
 *
 * Peer dep: React 18+ (concurrent-safe). React is marked optional so
 * non-React consumers don't get an install warning.
 */

import * as React from "react";

import { Provider as RpcProvider } from "./provider";
import { WebSocketProvider, type Unsubscribe, type LogSubscriptionFilter } from "./ws-provider";
import { Wallet } from "./wallet";
import type { Account, Wave, WaveHeader, Log } from "./types";
import { Contract } from "./contract";

// ============================================================================
// Context
// ============================================================================

interface PydeContextValue {
  provider: RpcProvider;
  ws: WebSocketProvider | null;
  signer: Wallet | null;
}

const PydeContext = React.createContext<PydeContextValue | null>(null);

export interface PydeProviderProps {
  children: React.ReactNode;
  rpcUrl: string;
  /** Optional WS URL. If omitted, live-subscription hooks fall back to
   *  polling via the HTTP provider. */
  wsUrl?: string;
  /** Optional signer (Wallet). Surfaced via `usePydeSigner()`. */
  signer?: Wallet;
}

export function PydeProvider(props: PydeProviderProps): React.ReactElement {
  const provider = React.useMemo(() => new RpcProvider(props.rpcUrl), [props.rpcUrl]);

  const [ws, setWs] = React.useState<WebSocketProvider | null>(null);
  React.useEffect(() => {
    if (!props.wsUrl) {
      setWs(null);
      return;
    }
    const w = new WebSocketProvider(props.wsUrl);
    setWs(w);
    return () => {
      w.destroy();
    };
  }, [props.wsUrl]);

  const value = React.useMemo<PydeContextValue>(
    () => ({ provider, ws, signer: props.signer ?? null }),
    [provider, ws, props.signer],
  );

  return React.createElement(PydeContext.Provider, { value }, props.children);
}

function usePydeContext(hook: string): PydeContextValue {
  const ctx = React.useContext(PydeContext);
  if (!ctx) {
    throw new Error(`${hook} must be used inside <PydeProvider>`);
  }
  return ctx;
}

export function usePydeProvider(): RpcProvider {
  return usePydeContext("usePydeProvider").provider;
}

export function usePydeWebSocket(): WebSocketProvider | null {
  return usePydeContext("usePydeWebSocket").ws;
}

export function usePydeSigner(): Wallet | null {
  return usePydeContext("usePydeSigner").signer;
}

// ============================================================================
// Generic async-state primitive
// ============================================================================

interface AsyncState<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  /** Manually refetch. Returns the new value (or throws). */
  refetch: () => Promise<T | null>;
}

function useAsync<T>(
  fetcher: (() => Promise<T>) | null,
  deps: React.DependencyList,
): AsyncState<T> {
  const [data, setData] = React.useState<T | null>(null);
  const [error, setError] = React.useState<Error | null>(null);
  const [loading, setLoading] = React.useState<boolean>(false);

  const refetch = React.useCallback(async (): Promise<T | null> => {
    if (!fetcher) return null;
    setLoading(true);
    setError(null);
    try {
      const v = await fetcher();
      setData(v);
      return v;
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      setError(err);
      throw err;
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  React.useEffect(() => {
    if (!fetcher) {
      setData(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetcher()
      .then(
        (v) => {
          if (!cancelled) {
            setData(v);
            setError(null);
          }
        },
        (e) => {
          if (!cancelled) {
            setError(e instanceof Error ? e : new Error(String(e)));
          }
        },
      )
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, error, loading, refetch };
}

// ============================================================================
// Account / balance / nonce hooks
// ============================================================================

/** Read an account's PYDE balance. Returns null until the first fetch
 *  resolves; updates only when `address` changes (call `refetch()` to
 *  re-pull). For live updates, subscribe via `useBalance` + a
 *  `useEffect` that calls `refetch` on relevant events. */
export function useBalance(address: string | undefined): AsyncState<bigint> {
  const provider = usePydeProvider();
  return useAsync<bigint>(address ? () => provider.getBalance(address) : null, [provider, address]);
}

/** Read an account's nonce (next available slot in the 16-slot window). */
export function useNonce(address: string | undefined): AsyncState<bigint> {
  const provider = usePydeProvider();
  return useAsync<bigint>(address ? () => provider.getNonce(address) : null, [provider, address]);
}

/** Read the full Account record. */
export function useAccount(address: string | undefined): AsyncState<Account | null> {
  const provider = usePydeProvider();
  return useAsync<Account | null>(address ? () => provider.getAccount(address) : null, [
    provider,
    address,
  ]);
}

// ============================================================================
// Wave / chain head hooks
// ============================================================================

/** Read a specific wave header (or the latest, when `waveId` is undefined). */
export function useWave(waveId?: Wave): AsyncState<WaveHeader | null> {
  const provider = usePydeProvider();
  return useAsync<WaveHeader | null>(() => provider.getWave(waveId), [provider, waveId]);
}

/** Subscribe to the live wave-commit stream when a WS provider is bound.
 *  Falls back to no-op when there's no WS (HTTP-only provider). */
export function useLiveWave(): WaveHeader | null {
  const ws = usePydeWebSocket();
  const [head, setHead] = React.useState<WaveHeader | null>(null);

  React.useEffect(() => {
    if (!ws) return;
    let unsubscribe: Unsubscribe | null = null;
    let cancelled = false;
    ws.subscribeNewHeads((h) => setHead(h)).then((unsub) => {
      if (cancelled) {
        void unsub();
      } else {
        unsubscribe = unsub;
      }
    });
    return () => {
      cancelled = true;
      if (unsubscribe) void unsubscribe();
    };
  }, [ws]);

  return head;
}

// ============================================================================
// Contract hook
// ============================================================================

/** Build a Contract bound to the current provider + (optionally) the
 *  current signer. Memoised across re-renders with stable inputs. */
export function useContract(args: {
  abiJson: string;
  address: string;
  withSigner?: boolean;
}): Contract | null {
  const provider = usePydeProvider();
  const signer = usePydeSigner();
  return React.useMemo<Contract | null>(() => {
    try {
      const c = Contract.fromJson(args.abiJson, args.address, provider);
      return args.withSigner && signer ? c.connect(signer) : c;
    } catch {
      return null;
    }
  }, [args.abiJson, args.address, provider, signer, args.withSigner]);
}

// ============================================================================
// Event subscription hook
// ============================================================================

/** Subscribe to live events matching `filter`. Falls back to no-op when
 *  there's no WS bound. Re-issues the subscription if `filter` or the WS
 *  instance changes. */
export function useEvents(filter: LogSubscriptionFilter): Log[] {
  const ws = usePydeWebSocket();
  const [events, setEvents] = React.useState<Log[]>([]);

  // Serialise the filter for the dep array — React doesn't deep-equal.
  const filterKey = React.useMemo(() => JSON.stringify(filter), [filter]);

  React.useEffect(() => {
    if (!ws) return;
    let unsubscribe: Unsubscribe | null = null;
    let cancelled = false;
    ws.subscribeLogs(filter, (log) => {
      setEvents((prev) => [...prev, log]);
    }).then((unsub) => {
      if (cancelled) {
        void unsub();
      } else {
        unsubscribe = unsub;
      }
    });
    return () => {
      cancelled = true;
      if (unsubscribe) void unsubscribe();
    };
    // filterKey is the serialised representation; ws is the provider instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws, filterKey]);

  return events;
}
