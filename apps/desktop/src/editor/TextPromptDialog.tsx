import { useEffect, useState } from 'react';
import { Dialog, Button, Icon } from '@aura/ui';
import type { ActionSpec } from './actionSpecs';

/** The small text-input step for the 3 actions that need one: Custom Prompt, Rename, Convert. */
export function TextPromptDialog({
  open,
  spec,
  defaultValue = '',
  onSubmit,
  onClose,
}: {
  open: boolean;
  spec: ActionSpec | null;
  defaultValue?: string;
  onSubmit: (value: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(defaultValue);

  useEffect(() => {
    if (open) setValue(defaultValue);
  }, [open, defaultValue]);

  if (!spec) return null;
  const isTextarea = spec.id === 'custom';

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="sm"
      title={spec.label}
      description={spec.inputLabel}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            icon={spec.icon}
            disabled={!value.trim()}
            onClick={() => onSubmit(value.trim())}
          >
            {spec.label}
          </Button>
        </>
      }
    >
      {isTextarea ? (
        <textarea
          autoFocus
          rows={4}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={spec.inputPlaceholder}
          className="w-full resize-none rounded-xl border border-line bg-canvas px-3.5 py-2.5 text-[13px] text-text outline-none placeholder:text-text-subtle focus:border-accent"
        />
      ) : (
        <div className="flex items-center gap-2 rounded-xl border border-line bg-canvas px-3.5 py-2.5 focus-within:border-accent">
          <Icon name={spec.icon} size={15} className="shrink-0 text-text-subtle" />
          <input
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && value.trim()) onSubmit(value.trim()); }}
            placeholder={spec.inputPlaceholder}
            className="w-full bg-transparent text-[13px] text-text outline-none placeholder:text-text-subtle"
          />
        </div>
      )}
    </Dialog>
  );
}
