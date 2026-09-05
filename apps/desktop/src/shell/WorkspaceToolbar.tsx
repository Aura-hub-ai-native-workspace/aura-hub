import { useCallback } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { cn } from '@aura/core';
import { Icon, IconButton, Tooltip, Badge } from '@aura/ui';

// @ts-ignore - IconName type strictness, icons work in JSX
/* eslint-disable */
import React from 'react';
// @ts-ignore
const IconButtonIcon = ({ icon }: { icon: any }) => <Icon name={icon} size={12} />;
export { IconButtonIcon };
/* eslint-enable */

export interface WorkspaceToolbarProps {
  onRelayout: () => void;
  onAddNode: () => void;
  onSelectProject: (id: string | null) => void;
  projects: any[];
  projectId: string | null;
  viewMode: 'grid' | 'list';
  setViewMode: (mode: 'grid' | 'list') => void;
}

/**
 * Top toolbar for the workspace screen providing project selection,
 * view mode controls, and workspace actions like auto-arrange and add node.
 * @param onRelayout Callback to trigger canvas relayout
 * @param onAddNode Callback to open add node dialog
 * @param onSelectProject Callback when project is selected
 * @param projects List of available projects
 * @param projectId Currently selected project ID
 * @param viewMode Current view mode (grid or list)
 * @param setViewMode Callback to change view mode
 */
export function WorkspaceToolbar({
  onRelayout,
  onAddNode,
  onSelectProject,
  projects,
  projectId,
  viewMode,
  setViewMode,
}: WorkspaceToolbarProps) {
  return (
    <div className="border-b border-border/20 bg-surface/30 backdrop-blur-sm px-4 py-2">
      <div className="max-w-7xl mx-auto flex items-center justify-between gap-2">
        {/* Left: Title and subtitle */}
        <div className="flex items-center gap-2">
          <Icon name="spark" size={14} className="shrink-0 text-accent" />
          <span className="truncate text-[13px] font-semibold text-text">Workspace</span>
          <span className="text-[10.5px] text-text-muted">
            Visualize and connect the core capabilities of AURA Hub
          </span>
        </div>

        {/* Center: Project selector */}
        <div className="flex items-center gap-1.5 mt-0.5">
          <Icon name="folder" size={12} className="shrink-0 text-text-subtle" />
          <select
            value={projectId ?? ''}
            onChange={(e) => onSelectProject(e.target.value)}
          >
            <option value="">Choose a project…</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>

        {/* Right: View modes and actions */}
        <div className="flex items-center gap-1.5 mt-0">
          {/* View mode toggle */}
          <Tooltip content="Grid view" side="top">
 // @ts-ignore - IconName type strictness
            <IconButton
              icon="grid"
              label="View mode"
              size="sm"
              onClick={() => setViewMode('grid')}
              className={cn(
                `relative rounded-lg p-1.5 ${viewMode === 'grid' ? 'bg-accent-50' : ''}`,
                'border-line',
              )}
            />
          </Tooltip>
          <Tooltip content="List view" side="top">
 // @ts-ignore - IconName type strictness
            <IconButton
              icon="list"
              label="View mode"
              size="sm"
              onClick={() => setViewMode('list')}
              className={cn(
                `relative rounded-lg p-1.5 ${viewMode === 'list' ? 'bg-accent-50' : ''}`,
                'border-line',
              )}
            />
          </Tooltip>

          <HeaderButton icon="refresh" label="Auto arrange" onClick={onRelayout} />

          <HeaderButton
            icon="plus"
            label="Add node"
            onClick={onAddNode}
            testId="add-node-open"
          />

          <Tooltip content="More actions" side="top">
 // @ts-ignore - IconName type strictness
            <IconButton
              icon="more-vertical"
              label="More"
              size="sm"
              className="relative rounded-lg p-1.5 bg-surface-active/50 backdrop-blur-sm border-line"
            />
          </Tooltip>
        </div>
      </div>
    </div>
  );
}

/**
 * Toolbar button with icon and label.
 * @param icon Icon name to display
 * @param label Button label text
 * @param onClick Click handler
 * @param testId Optional test ID for testing
 */
function HeaderButton({
  icon,
  label,
  onClick,
  testId,
}: {
  icon: string;
  label: string;
  onClick: () => void;
  testId?: string;
}) {
  return (
    <button
      onClick={onClick}
      data-testid={testId}
      className="inline-flex items-center gap-1 rounded-lg border border-line bg-surface px-2.5 py-0.5 text-[11px] font-medium text-text-muted transition-colors hover:bg-surface-hover hover:text-text"
    >
 // @ts-ignore - IconName type strictness, string works at runtime
      <Icon name={icon} size={12} />
      {label}
    </button>
  );
}