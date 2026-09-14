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
  title: 'GRIDFLEX — ERCOT markets on X Layer',
  description:
    'Cash-settled ERCOT outcome markets backed by verifiable source data on X Layer.',
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
