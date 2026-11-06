"use client";

import { useMemo, useState } from "react";

/**
 * While the pointer is over a live table, keep rows where they are so they do not jump
 * under the cursor. Values keep updating; the order catches up when the pointer leaves.
 */
export function useFrozenOrder<T>(rows: T[], keyOf: (row: T) => string) {
  const [frozen, setFrozen] = useState<string[] | null>(null);

  const ordered = useMemo(() => {
    if (!frozen) return rows;
    const byKey = new Map(rows.map((row) => [keyOf(row), row]));
    const kept = frozen.map((key) => byKey.get(key)).filter((row): row is T => row !== undefined);
    if (kept.length === rows.length) return kept;
    const seen = new Set(frozen);
    return [...kept, ...rows.filter((row) => !seen.has(keyOf(row)))];
  }, [rows, frozen, keyOf]);

  return {
    rows: ordered,
    frozen: frozen != null,
    bind: {
      onPointerEnter: (event: React.PointerEvent) => {
        if (event.pointerType === "mouse") setFrozen(rows.map(keyOf));
      },
      onPointerLeave: () => setFrozen(null),
    },
  };
}
