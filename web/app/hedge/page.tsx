import type { Metadata } from 'next';

import { Footer } from '@/components/footer';
import { HedgePlanner } from '@/components/hedge-planner';
import { SiteHeader } from '@/components/site-header';

export const metadata: Metadata = {
  title: 'Hedge — GRIDFLEX',
};

export default function HedgePage() {
  return (
    <>
      <SiteHeader />
      <main className="qg-page">
        <HedgePlanner />
        <Footer />
      </main>
    </>
  );
}
