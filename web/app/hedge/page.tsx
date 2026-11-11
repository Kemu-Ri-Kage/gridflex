import type { Metadata } from 'next';

import { Footer } from '@/components/footer';
import { HedgePlanner } from '@/components/hedge-planner';
import { TerminalHeader } from '@/components/site-header';

export const metadata: Metadata = {
  title: 'Hedge — GRIDFLEX',
};

export default function HedgePage() {
  return (
    <main className="flex min-h-screen flex-col bg-background text-foreground">
      <TerminalHeader current="hedge" />
      <HedgePlanner />
      <Footer variant="terminal" />
    </main>
  );
}
