import { Suspense } from "react";
import { io } from "next/cache";

import { TerminalSkeleton } from "@/components/skeleton";
import { Terminal } from "@/components/terminal";
import { getSnapshot } from "@/lib/snapshot";

// The Txflow book fans out one marketTicker per perp. Cold start needs more than the default limit.
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
