import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import {
  selectHighlightedSources,
  SourcesPage,
  type SourceSummary,
} from "./SourceIntelligence";

let root: Root | undefined, container: HTMLDivElement | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = undefined;
  vi.unstubAllGlobals();
});

const summary = (id: string, totalVacancies: number): SourceSummary => ({
  id,
  totalVacancies,
  uniqueVacancies: totalVacancies,
  sharedVacancies: 0,
  overlaps: [],
});

describe("source evidence", () => {
  it("pins the main boards and limits additional sources by vacancy volume", () => {
    const selected = selectHighlightedSources([
      summary("small-directory", 2),
      summary("jobspy-glassdoor", 4),
      summary("largest-directory", 30),
      summary("jobspy-indeed", 8),
      summary("fourth-directory", 3),
      summary("linkedin-guest", 12),
      summary("second-directory", 20),
      summary("third-directory", 10),
    ]);
    expect(selected.map((source) => source.id)).toEqual([
      "linkedin-guest",
      "jobspy-indeed",
      "jobspy-glassdoor",
      "largest-directory",
      "second-directory",
      "third-directory",
    ]);
  });

  it("requests cross-source evidence for the selected page window", async () => {
    const calls: string[] = [];
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("fetch", vi.fn((path: string) => {
      calls.push(path);
      const data = path.startsWith("/api/v1/source-performance")
        ? { items: [] }
        : path === "/api/v1/coverage/benchmark"
          ? { version: "test", label: "Test panel", states: {}, total: 0, matched: 0, checked30d: 0, hiringSignals30d: 0, byRegion: [], bySector: [], bySize: [], byOwnership: [] }
          : path === "/api/v1/coverage/trace"
            ? { boardsResolved: 0, boardsCompletelyCollected: 0, unknownCollectionBoards: 0, pendingContinuations: 0, unresolvedEmployers: 0, netherlandsVacanciesObserved: 0, rejectionReasons: [], enrichment: [] }
            : path === "/api/v1/enrichment/queue/items"
              ? { items: [] }
          : { window: path.includes("lifetime") ? "lifetime" : "30d", sources: ["linkedin-guest"], summaries: [summary("linkedin-guest", 5)], pairs: [] };
      return Promise.resolve({ ok: true, json: async () => data });
    }));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<MemoryRouter><SourcesPage /></MemoryRouter>));
    expect(calls).toContain("/api/v1/coverage/overlap?window=30d");
    expect(container.querySelector(".source-evidence-grid")?.textContent).toContain("LinkedIn");
    const lifetime = [...container.querySelectorAll("button")].find((button) => button.textContent === "Lifetime");
    await act(async () => lifetime!.click());
    expect(calls).toContain("/api/v1/coverage/overlap?window=lifetime");
  });
});
