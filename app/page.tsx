import { Suspense } from "react";
import { io } from "next/cache";

import { TerminalSkeleton } from "@/components/skeleton";
import { Terminal } from "@/components/terminal";
import { getSnapshot } from "@/lib/snapshot";

// The response returns without the ticker fan-out. waitUntil keeps refreshing inside this budget.
export const maxDuration = 60;

export default function Page() {
  return (
    <main>
      <Suspense fallback={<TerminalSkeleton />}>
        <LiveBook />
      </Suspense>
    </main>
  );
}

async function LiveBook() {
  await io();
  const snapshot = await getSnapshot();
  return <Terminal initial={snapshot} />;
}
