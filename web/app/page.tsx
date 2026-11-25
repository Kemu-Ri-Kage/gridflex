import { Footer } from '@/components/footer';
import { Home } from '@/components/landing/home';
import { SiteHeader } from '@/components/site-header';
import { MarketsProvider } from '@/lib/markets';

export default function HomePage() {
  return (
    <MarketsProvider>
      <SiteHeader />
      <main className="qg-page">
        <div className="page-body">
          <Home />
        </div>
        <Footer />
      </main>
    </MarketsProvider>
  );
}
