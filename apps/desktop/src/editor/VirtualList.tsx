import { useEffect, useRef, useState, type ReactNode, type UIEvent } from 'react';

/**
 * A minimal, dependency-free windowed list. The Code Workspace's file
 * tree is the one surface in AURA that can realistically hit tens of
 * thousands of rows (a real `node_modules`-adjacent repo), so it's the
 * one place a generic Tailwind `space-y` list isn't good enough —
 * mounting every row would visibly stutter on open.
 *
 * Self-measuring: fills whatever height its parent's flexbox gives it
 * (via ResizeObserver) rather than requiring a fixed pixel height prop.
 */
export function VirtualList<T>({
  items,
  itemHeight,
  renderItem,
  overscan = 8,
  className,
  emptyState,
}: {
  items: T[];
  itemHeight: number;
  renderItem: (item: T, index: number) => ReactNode;
  overscan?: number;
  className?: string;
  emptyState?: ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setViewportHeight(entry.contentRect.height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (items.length === 0) {
    return (
      <div ref={containerRef} className={className}>
        {emptyState}
      </div>
    );
  }

  const total = items.length * itemHeight;
  const startIdx = Math.max(0, Math.floor(scrollTop / itemHeight) - overscan);
  const visibleCount = Math.ceil(viewportHeight / itemHeight) + overscan * 2;
  const endIdx = Math.min(items.length, startIdx + Math.max(0, visibleCount));
  const offsetY = startIdx * itemHeight;

  return (
    <div
      ref={containerRef}
      className={className}
      onScroll={(e: UIEvent<HTMLDivElement>) => setScrollTop(e.currentTarget.scrollTop)}
    >
      <div style={{ height: total, position: 'relative' }}>
        <div style={{ position: 'absolute', top: offsetY, left: 0, right: 0 }}>
          {items.slice(startIdx, endIdx).map((item, i) => (
            <div key={startIdx + i} style={{ height: itemHeight }}>
              {renderItem(item, startIdx + i)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
