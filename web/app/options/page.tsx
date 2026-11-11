import type { Metadata } from 'next';

import { Footer } from '@/components/footer';
import { OptionsTerminal } from '@/components/options-terminal';
import { SiteHeader } from '@/components/site-header';

export const metadata: Metadata = {
  title: 'Options — GRIDFLEX',
};

export default function OptionsPage() {
  return (
    <>
      <SiteHeader />
      <main className="qg-page">
        <OptionsTerminal />
        <Footer />
      </main>
    </>
  );
}
