import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';

import { WalletLinkArrival } from '@/components/open-in-wallet-app';
import { WalletApproval } from '@/components/wallet-approval';
import { Web3Provider } from '@/components/web3-provider';

import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

/** The site's one public address. workers.dev still serves it (and the API
 * the OKX.AI agent was registered with), so every page names this one as
 * canonical for search engines. */
const SITE_URL = 'https://gridflex.dev';

/** Who GRIDFLEX is, for search engines (schema.org, read by Google). */
const STRUCTURED_DATA = JSON.stringify({
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'Organization',
      name: 'GRIDFLEX',
      url: SITE_URL,
      logo: `${SITE_URL}/favicon.svg`,
      description:
        'On-chain energy derivatives: cash-settled Long and Short contracts on the Texas power price, on X Layer.',
      sameAs: [
        'https://github.com/Kemu-Ri-Kage/gridflex',
        'https://www.youtube.com/watch?v=PKY4Y8EqxmQ',
      ],
    },
    { '@type': 'WebSite', name: 'GRIDFLEX', url: SITE_URL },
  ],
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  alternates: { canonical: '/' },
  title: 'GRIDFLEX — Texas power derivatives',
  description:
    'On-chain energy derivatives, no broker: cash-settled digital options on the Texas power price, hedged from a wallet and settled against prices published onchain with a hash of their source.',
  // A text-only link card for X and Telegram (no image: GRIDFLEX has no logo).
  openGraph: {
    title: 'GRIDFLEX — Texas power derivatives',
    description:
      'On-chain energy derivatives, no broker: cash-settled digital options on the Texas power price, settled on X Layer against prices published onchain with a hash of their source.',
    url: SITE_URL,
    siteName: 'GRIDFLEX',
    type: 'website',
  },
  // A plain near-black tile, no mark - GRIDFLEX has no logo (design-brief.md §2).
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: '16x16 32x32 48x48' },
      { url: '/favicon.svg', type: 'image/svg+xml' },
    ],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <script
          type="application/ld+json"
          // A fixed constant built above, never user input.
          dangerouslySetInnerHTML={{ __html: STRUCTURED_DATA }}
        />
        <Web3Provider>
          <WalletLinkArrival />
          {children}
          <WalletApproval />
        </Web3Provider>
      </body>
    </html>
  );
}
