"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * A table cell that tints for 600 ms when its value moves: green up, red down.
 * Uses the Web Animations API on the element, so no re-render and nothing on first paint.
 */
export function LiveCell({
  value,
  className,
  children,
  label,
}: {
  value: number | null;
  className?: string;
  children: ReactNode;
  label?: string;
}) {
  const ref = useRef<HTMLTableCellElement>(null);
  const previous = useRef(value);

  useEffect(() => {
    const before = previous.current;
    previous.current = value;
    const el = ref.current;
    if (!el || before == null || value == null || before === value) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const wash = value > before ? "var(--up-wash)" : "var(--down-wash)";
    el.animate([{ boxShadow: `inset 0 0 0 999px ${wash}` }, { boxShadow: "inset 0 0 0 999px transparent" }], {
      duration: 600,
      easing: "ease-out",
    });
  }, [value]);

  return (
    <td ref={ref} className={className} data-label={label}>
      {children}
    </td>
  );
}
