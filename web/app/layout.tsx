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
  title: 'GRIDFLEX — Will Texas power cost more?',
  description:
    'YES/NO questions on the Texas power price, settled against prices published onchain with a hash of their source.',
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
