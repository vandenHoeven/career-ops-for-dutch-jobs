import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Link } from "react-router-dom";
import { api } from "./api";

export type ActiveDiscoveryRun = Record<string, any> & {
  id: string;
  status: string;
};

type DiscoveryStatusValue = {
  activeRun: ActiveDiscoveryRun | null;
  announceStarted: (run: ActiveDiscoveryRun) => void;
  refresh: () => Promise<void>;
};
type DiscoveryStatusResponse = { active: boolean; run: ActiveDiscoveryRun | null };

const DiscoveryStatusContext = createContext<DiscoveryStatusValue | null>(null);

export function DiscoveryStatusProvider({ children }: { children: ReactNode }) {
  const [activeRun, setActiveRun] = useState<ActiveDiscoveryRun | null>(null);
  const activeRef = useRef(false);
  const requestSequence = useRef(0);
  const appliedSequence = useRef(0);

  const refresh = useCallback(() => {
    const sequence = ++requestSequence.current;
    return api<DiscoveryStatusResponse>("/api/v1/discovery/status")
      .then((status) => {
        if (sequence < appliedSequence.current) return;
        appliedSequence.current = sequence;
        const run = status.active ? status.run : null;
        activeRef.current = Boolean(run);
        setActiveRun(run ?? null);
      })
      .catch(() => {
        // Keep the last known state through a transient dashboard API failure.
      });
  }, []);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      await refresh();
      if (live) timer = setTimeout(poll, activeRef.current ? 2_000 : 5_000);
    };
    void poll();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [refresh]);

  const announceStarted = useCallback(
    (run: ActiveDiscoveryRun) => {
      appliedSequence.current = requestSequence.current + 1;
      activeRef.current = true;
      setActiveRun((current) => ({ ...current, ...run } as ActiveDiscoveryRun));
      void refresh();
    },
    [refresh],
  );

  const value = useMemo(
    () => ({ activeRun, announceStarted, refresh }),
    [activeRun, announceStarted, refresh],
  );
  return (
    <DiscoveryStatusContext.Provider value={value}>
      {children}
    </DiscoveryStatusContext.Provider>
  );
}

export function useDiscoveryStatus(): DiscoveryStatusValue {
  const value = useContext(DiscoveryStatusContext);
  if (!value)
    throw new Error("useDiscoveryStatus must be used inside DiscoveryStatusProvider");
  return value;
}

function remainingLabel(run: ActiveDiscoveryRun): string {
  const deadline = run.deadline_at ?? run.deadlineAt;
  const seconds = Number(run.adaptive?.remainingSeconds ?? run.eta?.seconds ?? (deadline ? Math.max(0, Math.ceil((Date.parse(deadline) - Date.now()) / 1000)) : Number.NaN));
  if (!Number.isFinite(seconds)) return "Calculating time remaining";
  if (seconds <= 0) return "Draining active work";
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.max(0, Math.ceil(seconds % 60));
  return `${minutes}:${String(remainder).padStart(2, "0")} remaining`;
}

export function DiscoveryRunningBanner() {
  const { activeRun } = useDiscoveryStatus();
  if (!activeRun) return null;
  const phase = String(activeRun.phase ?? "starting").replaceAll("-", " ");
  return (
    <Link
      className="discovery-running-banner"
      to="/discovery"
      aria-label="Discovery is running. Open discovery details."
    >
      <span className="discovery-running-dot" aria-hidden="true" />
      <span className="discovery-running-copy" aria-live="polite">
        <strong>Discovery running</strong>
        <small>
          {phase} · {remainingLabel(activeRun)}
        </small>
      </span>
      <span className="discovery-running-metrics">
        <b>{activeRun.processed_count ?? 0}</b> processed
        <b>{activeRun.new_strong_count ?? 0}</b> new strong
      </span>
      <span className="discovery-running-link">View discovery →</span>
    </Link>
  );
}
