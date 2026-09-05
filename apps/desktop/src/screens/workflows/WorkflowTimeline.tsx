import { useMemo } from 'react';
import { motion } from 'framer-motion';
import { cn } from '@aura/core';
import { Icon, Badge } from '@aura/ui';

type AgentStatus =
  | 'idle'
  | 'planning'
  | 'analyzing'
  | 'coding'
  | 'generating'
  | 'executing'
  | 'completed'
  | 'failed';

type TimelineItem = {
  id: string;
  agent: string;
  role: string;
  description: string;
  status: AgentStatus;
  timestamp: string;
  result?: string;
};

const STATUS_COLORS: Record<AgentStatus, string> = {
  idle: 'bg-sidebar text-sidebarSubtle',
  planning: 'bg-violet-500/15 text-violet-500',
  analyzing: 'bg-amber-500/15 text-amber-500',
  coding: 'bg-blue-500/15 text-blue-500',
  generating: 'bg-violet-500/15 text-violet-500',
  executing: 'bg-cyan-500/15 text-cyan-500',
  completed: 'bg-green-500/15 text-green-500',
  failed: 'bg-rose-500/15 text-rose-500',
};

const STATUS_LABELS: Record<AgentStatus, string> = {
  idle: 'Idle',
  planning: 'Planning',
  analyzing: 'Analyzing',
  coding: 'Coding',
  generating: 'Generating',
  executing: 'Executing',
  completed: 'Completed',
  failed: 'Failed',
};

/**
 * Displays a visual timeline of workflow execution showing agent activities,
 * task plans, and provider operations. Updates in real-time as missions progress.
 * @param active Active mission record
 * @param progress Current hub progress state
 */
export function WorkflowTimeline({
  active,
  progress,
}: {
  active: any;
  progress: any;
}) {
  const timelineItems = useMemo<TimelineItem[]>(() => {
    if (!active) return [];

    const items: TimelineItem[] = [];

    // AURA Agent entry
    items.push({
      id: 'aura-agent-1',
      agent: 'AURA Agent',
      role: 'Orchestration',
      description: 'Analyzing your request and planning the workflow',
      status: progress.phase === 'idle' ? 'idle' : getStatusFromPhase(progress.phase),
      timestamp: new Date().toLocaleTimeString(),
    });

    // Task Plan entries
    if (active?.goalGraph?.tasks?.length) {
      items.push({
        id: 'task-plan',
        agent: 'Task Plan',
        role: 'Planning',
        description:
          (active.goalGraph.tasks as any[])
            .map((t: any) => `- ${t.title}`)
            .join('\n') || 'No tasks defined',
        status: 'planning',
        timestamp: new Date().toISOString(),
      });
    }

    // If execution is running, show provider entries
    if (active?.execution?.status === 'running') {
      items.push({
        id: 'provider-1',
        agent: 'OpenAI',
        role: 'Reasoning',
        description: 'Generating application architecture',
        status: 'analyzing',
        timestamp: new Date().toISOString(),
      });

      items.push({
        id: 'provider-2',
        agent: 'Gemini',
        role: 'Multimodal',
        description: 'Generating UI design and assets',
        status: 'generating',
        timestamp: new Date().toISOString(),
      });
    }

    // Completed entry if mission is complete
    if (active?.execution?.status === 'completed') {
      items.push({
        id: 'aura-agent-2',
        agent: 'AURA Agent',
        role: 'Orchestration',
        description: 'Work completed',
        status: 'completed',
        timestamp: new Date().toISOString(),
      });
    }

    return items;
  }, [active, progress]);

  /**
   * Maps hub phase to agent status for timeline visualization.
   * @param phase Current hub phase string
   * @returns Corresponding agent status for display
   */
  const getStatusFromPhase = (phase: string): AgentStatus => {
    const mapping: Record<string, AgentStatus> = {
      idle: 'idle',
      understanding: 'planning',
      planning: 'planning',
      preparing: 'planning',
      'awaiting-approval': 'planning',
      executing: 'executing',
      verifying: 'executing',
      completed: 'completed',
      failed: 'failed',
    };
    return mapping[phase] ?? 'idle';
  };

  return (
    <div className="space-y-1.5 pt-2">
      {timelineItems.map((item: TimelineItem) => (
        <motion.div
          key={item.id}
          initial={{ x: -20, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: 20, opacity: 0 }}
          transition={ { duration: 0.3 }}
          className="flex items-start gap-2.5"
        >
          {/* Status pill */}
          <span
            className={cn(
              'flex-shrink-0 h-5 w-5 rounded-full text-[8.5px] font-medium',
              STATUS_COLORS[item.status],
            )}
          >
            {STATUS_LABELS[item.status]}
          </span>

          {/* Agent name and role */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1">
              <Icon name="cpu" size={13} className="text-[11px]" />
              <span className="text-[11.5px] font-medium truncate">
                {item.agent}
              </span>
              <span className="text-[9.5px] text-text-subtle">{item.role}</span>
            </div>
            <p className="text-[10.5px] text-truncate line-clamp-2 mt-0.5">
              {item.description}
            </p>
          </div>

          {/* Status and timestamp */}
          <div className="text-right text-[8.5px]">
            <span className="text-text-subtle">{item.timestamp}</span>
            <Badge
              className="ml-1 text-[7.5px] py-0.5"
              tone={STATUS_COLORS[item.status] as any}
            >
              {STATUS_LABELS[item.status]}
            </Badge>
          </div>
        </motion.div>
      ))}
    </div>
  );
}