/**
 * ValidationStrip — what is wrong with the graph, before it runs.
 * ==================================================================
 * Sits directly above the canvas and is absent entirely when there is
 * nothing to say — a strip that is always present stops being read.
 *
 * Errors disable Run. Warnings do not. Advice only appears when the strip
 * is expanded. Every finding names the node it is about and can focus it.
 */

import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Icon } from '@aura/ui';
import { spring } from '@aura/core';
import type { Finding, FindingLevel, ValidationReport } from './validation';

const LEVEL_ICON: Record<FindingLevel, 'close' | 'bell' | 'eye'> = {
  error: 'close',
  warning: 'bell',
  advice: 'eye',
};

const LEVEL_COLOR: Record<FindingLevel, string> = {
  error: 'text-danger',
  warning: 'text-attention',
  advice: 'text-text-subtle',
};

export function ValidationStrip({
  report,
  onFocusNode,
}: {
  report: ValidationReport;
  onFocusNode: (nodeId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const visible = report.errors + report.warnings;
  if (!visible && !report.advice) return null;

  const tone = report.errors
    ? 'border-danger/35 bg-danger/[0.06]'
    : report.warnings
      ? 'border-attention/35 bg-attention/[0.06]'
      : 'border-line bg-surface';

  const shown: Finding[] = open
    ? report.findings
    : report.findings.filter((f) => f.level !== 'advice');

  return (
    <div className={`shrink-0 border-b ${tone}`}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-4 py-1.5 text-left"
        aria-expanded={open}
      >
        {report.errors > 0 ? (
          <Icon name="close" size={13} className="text-danger" />
        ) : report.warnings > 0 ? (
          <Icon name="bell" size={13} className="text-attention" />
        ) : (
          <Icon name="eye" size={13} className="text-text-subtle" />
        )}
        <span className="min-w-0 truncate text-[11.5px] font-medium text-text">
          {/* One problem gets named, not counted. A count is only useful
              once there are several to triage. */}
          {visible === 1
            ? (report.findings.find((f) => f.level !== 'advice')?.message ?? '')
            : (
              <>
                {report.errors > 0 && `${report.errors} problem${report.errors === 1 ? '' : 's'} stopping this run`}
                {report.errors > 0 && report.warnings > 0 && ' · '}
                {report.warnings > 0 && `${report.warnings} warning${report.warnings === 1 ? '' : 's'}`}
                {!visible && report.advice > 0 && `${report.advice} suggestion${report.advice === 1 ? '' : 's'}`}
              </>
            )}
        </span>
        {!open && report.advice > 0 && visible > 0 && (
          <span className="text-[10.5px] text-text-subtle">+{report.advice} suggestion{report.advice === 1 ? '' : 's'}</span>
        )}
        <span className="ml-auto text-[10.5px] text-text-subtle">{open ? 'hide' : 'show'}</span>
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.ul
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={spring.smooth}
            className="overflow-hidden border-t border-line/60"
          >
            {shown.map((f) => (
              <li key={f.id} className="border-b border-line/50 last:border-b-0">
                <button
                  onClick={() => f.nodeId && onFocusNode(f.nodeId)}
                  disabled={!f.nodeId}
                  className="flex w-full items-start gap-2.5 px-4 py-2 text-left transition-colors enabled:hover:bg-surface-hover disabled:cursor-default"
                >
                  <Icon name={LEVEL_ICON[f.level]} size={11} className={`mt-0.5 shrink-0 ${LEVEL_COLOR[f.level]}`} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[11.5px] leading-snug text-text">{f.message}</span>
                    {f.fix && <span className="mt-0.5 block text-[10.5px] leading-snug text-text-muted">{f.fix}</span>}
                  </span>
                  {f.nodeId && <span className="mt-0.5 shrink-0 text-[10px] text-text-subtle">show</span>}
                </button>
              </li>
            ))}
          </motion.ul>
        )}
      </AnimatePresence>
    </div>
  );
}
