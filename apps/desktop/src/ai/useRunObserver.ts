/**
 * useRunObserver — keeps a RunView for one session: seeded from what the
 * backend stored (so a reload or restart shows the recorded outcome), then
 * advanced by the live event stream. The stream reconnects and replays from
 * its last sequence on its own; the reducer ignores frames it has seen.
 */
import { useEffect, useState } from 'react';
import { centralAgentClient } from './centralAgentClient';
import { EMPTY_RUN, foldRunEvent, seedFromReport, type RunView } from './runObserver';

export function useRunObserver(sessionId: string | null | undefined, live: boolean): RunView {
  const [view, setView] = useState<RunView>(EMPTY_RUN);

  useEffect(() => {
    setView(EMPTY_RUN);
    if (!sessionId) return;
    let cancelled = false;
    // What the backend already knows. A finished run's report is authoritative.
    centralAgentClient.getSession(sessionId).then((s) => {
      if (cancelled) return;
      const report = s.lastResult?.report;
      if (report) setView((v) => seedFromReport(sessionId, report, v));
    }).catch(() => { /* the live stream below still works */ });
    if (!live) return () => { cancelled = true; };
    const stop = centralAgentClient.events(sessionId, (frame) => { if (!cancelled) setView((v) => foldRunEvent(v, frame)); });
    return () => { cancelled = true; stop(); };
  }, [sessionId, live]);

  return view;
}
