import type { Metadata } from 'next';

import { Footer } from '@/components/footer';
import { FuturesTerminal } from '@/components/futures-terminal';
import { SiteHeader } from '@/components/site-header';

export const metadata: Metadata = {
  title: 'Futures — GRIDFLEX',
};

export default function FuturesPage() {
  return (
    <>
      <SiteHeader />
      <main className="qg-page">
        <FuturesTerminal />
        <Footer />
      </main>
    </>
  );
}
