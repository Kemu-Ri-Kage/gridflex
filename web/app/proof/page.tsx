import type { Metadata } from 'next';

import { Footer } from '@/components/footer';
import { ProofPage } from '@/components/proof-page';
import { SiteHeader } from '@/components/site-header';
import { MarketsProvider } from '@/lib/markets';

export const metadata: Metadata = {
  title: 'Proof — GRIDFLEX',
};

export default function Proof() {
  return (
    <MarketsProvider>
      <SiteHeader />
      <main className="qg-page">
        <ProofPage />
        <Footer />
      </main>
    </MarketsProvider>
  );
}
