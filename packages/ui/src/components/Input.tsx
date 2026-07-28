import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react';
import { cn } from '@aura/core';
import { Icon, type IconName } from '../icons/Icon';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  icon?: IconName;
  /** Trailing adornment — e.g. a keyboard shortcut hint. */
  suffix?: ReactNode;
  invalid?: boolean;
  inputSize?: 'sm' | 'md' | 'lg';
}

const SIZES = {
  sm: 'h-8 text-[12px] rounded-lg',
  md: 'h-9 text-[13px] rounded-xl',
  lg: 'h-11 text-[14px] rounded-2xl',
} as const;

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { icon, suffix, invalid, inputSize = 'md', className, ...rest },
  ref,
) {
  return (
    <div
      className={cn(
        'group relative flex items-center bg-surface border transition-colors duration-150',
        'border-line focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/20',
        invalid && 'border-danger focus-within:border-danger focus-within:ring-danger/20',
        SIZES[inputSize],
        className,
      )}
    >
      {icon && (
        <Icon name={icon} size={16} className="ml-3 text-text-subtle group-focus-within:text-accent" />
      )}
      <input
        ref={ref}
        className={cn(
          'peer w-full bg-transparent outline-none placeholder:text-text-subtle text-text',
          icon ? 'pl-2.5' : 'pl-3.5',
          suffix ? 'pr-2' : 'pr-3.5',
        )}
        {...rest}
      />
      {suffix && <div className="mr-2 shrink-0">{suffix}</div>}
    </div>
  );
});
