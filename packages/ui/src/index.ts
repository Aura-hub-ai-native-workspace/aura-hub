/**
 * @aura/ui — the AURA design system.
 * Reusable, animated, themeable. Consumed by every app + module.
 */

// Icons
export { Icon, type IconName, type IconProps } from './icons/Icon';

// Primitives
export { Button, type ButtonProps, type ButtonVariant, type ButtonSize } from './components/Button';
export { IconButton, type IconButtonProps } from './components/IconButton';
export { Badge, type BadgeProps } from './components/Badge';
export { Card, CardHeader, type CardProps } from './components/Card';
export { Input, type InputProps } from './components/Input';
export { Progress, Ring, type ProgressProps, type RingProps } from './components/Progress';
export { Skeleton, SkeletonCard, type SkeletonProps } from './components/Skeleton';
export { Tooltip, type TooltipProps } from './components/Tooltip';

// Composite
export { Tabs, Tab, type TabsProps, type TabProps } from './components/Tabs';
export { List, ListItem, type ListProps, type ListItemProps } from './components/List';
export { Table, type TableProps, type Column } from './components/Table';
export { PanelSection, PropertyRow, type PanelSectionProps } from './components/Panel';
export { Dropdown, type DropdownProps, type DropdownOption } from './components/Dropdown';
export { Menu, type MenuProps, type MenuItem } from './components/Menu';

// Overlays
export { Dialog, type DialogProps } from './components/Dialog';
export { CommandPalette, type CommandPaletteProps } from './components/CommandPalette';
export { ToastProvider, useToast } from './components/Toast';

// Hooks
export { useHotkey, type HotkeyOptions } from './hooks/useHotkey';
export { useMediaQuery } from './hooks/useMediaQuery';
