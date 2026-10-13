import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';

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

export const metadata: Metadata = {
  title: 'GRIDFLEX — Texas power derivatives',
  description:
    'On-chain energy derivatives, no broker: cash-settled digital options on the Texas power price, hedged from a wallet and settled against prices published onchain with a hash of their source.',
  // A text-only link card for X and Telegram (no image: GRIDFLEX has no logo).
  openGraph: {
    title: 'GRIDFLEX — Texas power derivatives',
    description:
      'On-chain energy derivatives, no broker: cash-settled digital options on the Texas power price, settled on X Layer against prices published onchain with a hash of their source.',
    url: 'https://gridflex-web.teslenko-platon.workers.dev',
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
        <Web3Provider>{children}</Web3Provider>
      </body>
    </html>
  );
}
