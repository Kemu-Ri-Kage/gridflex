import type { Metadata } from 'next';

import { Footer } from '@/components/footer';
import { OptionsTerminal } from '@/components/options-terminal';
import { TerminalHeader } from '@/components/site-header';

export const metadata: Metadata = {
  title: 'Options — GRIDFLEX',
};

export default function OptionsPage() {
  return (
    <main className="flex min-h-screen flex-col bg-background text-foreground">
      <TerminalHeader current="options" />
      <OptionsTerminal />
      <Footer variant="terminal" />
    </main>
  );
}
