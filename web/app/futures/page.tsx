import type { Metadata } from 'next';

import { Footer } from '@/components/footer';
import { FuturesTerminal } from '@/components/futures-terminal';
import { TerminalHeader } from '@/components/site-header';

export const metadata: Metadata = {
  title: 'Futures — GRIDFLEX',
};

export default function FuturesPage() {
  return (
    <main className="flex min-h-screen flex-col bg-background text-foreground">
      <TerminalHeader current="futures" />
      <FuturesTerminal />
      <Footer variant="terminal" />
    </main>
  );
}
