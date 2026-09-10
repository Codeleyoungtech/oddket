"use client";

import React, { useCallback, useRef, useState, useEffect } from "react";

interface VirtualListProps<T> {
  /** The full list of items. */
  items: T[];
  /** Estimated height in pixels for each row. The list auto-adjusts but this
   *  controls the initial calculation and the total scroll height estimate. */
  estimatedHeight: number;
  /** Number of extra items to render above/below the viewport. */
  overscan?: number;
  /** Render function for each visible item. */
  renderItem: (item: T, index: number) => React.ReactNode;
  /** Optional key extractor for stable React keys. Falls back to index. */
  keyFn?: (item: T, index: number) => string;
  /** Optional className on the outer scrollable container. */
  className?: string;
}

/**
 * Virtual list that only mounts items currently in or near the viewport.
 *
 * Works with variable-height rows — it measures actual heights after mount
 * and adjusts the scroll spacer accordingly. The `estimatedHeight` prop is
 * used only for the initial layout pass so the browser can paint something
 * immediately.
 */
export function VirtualList<T>({
  items,
  estimatedHeight,
  overscan = 5,
  renderItem,
  keyFn,
  className,
}: VirtualListProps<T>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(0);
  const heightsRef = useRef<Map<number, number>>(new Map());

  const totalHeight =
    items.length > 0
      ? items.reduce(
          (sum, _, i) => sum + (heightsRef.current.get(i) ?? estimatedHeight),
          0,
        )
      : 0;

  // Measure the container height on mount and resize.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      setContainerHeight(entry.contentRect.height);
    });
    ro.observe(el);
    setContainerHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const handleScroll = useCallback(() => {
    setScrollTop(containerRef.current?.scrollTop ?? 0);
  }, []);

  // Compute which items are visible.
  const startIdx = Math.max(
    0,
    Math.floor(scrollTop / estimatedHeight) - overscan,
  );
  const visibleCount = Math.ceil(containerHeight / estimatedHeight) + overscan * 2;
  const endIdx = Math.min(items.length, startIdx + visibleCount);

  // Offset for the visible window: sum of heights before startIdx.
  let offsetTop = 0;
  for (let i = 0; i < startIdx; i++) {
    offsetTop += heightsRef.current.get(i) ?? estimatedHeight;
  }

  const visibleItems = items.slice(startIdx, endIdx);

  // After render, measure actual heights of visible items.
  const measureRef = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node) return;
      const children = node.children;
      for (let i = 0; i < children.length; i++) {
        const el = children[i] as HTMLElement;
        const idx = startIdx + i;
        const measured = el.getBoundingClientRect().height;
        if (Math.abs((heightsRef.current.get(idx) ?? measured) - measured) > 1) {
          heightsRef.current.set(idx, measured);
        }
      }
    },
    [startIdx],
  );

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className={`overflow-y-auto ${className ?? ""}`}
    >
      <div style={{ height: totalHeight, position: "relative" }}>
        <div
          ref={measureRef}
          style={{
            position: "absolute",
            top: offsetTop,
            left: 0,
            right: 0,
          }}
        >
          {visibleItems.map((item, i) => (
            <div key={keyFn ? keyFn(item, startIdx + i) : startIdx + i}>
              {renderItem(item, startIdx + i)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
