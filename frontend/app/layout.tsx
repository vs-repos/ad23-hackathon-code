import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'Analyst Days — build the agenda',
  description:
    'Build the two-day Analyst Days agenda from your talk list: speaker windows, staggered lunch shifts, interest weights.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="font-serif">
        <header className="no-print border-b border-stone-200 bg-white">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
            <Link href="/" className="text-sm font-semibold tracking-tight">
              Analyst Days · Agenda
            </Link>
            <nav className="flex gap-4 text-sm text-stone-600">
              <Link href="/" className="hover:text-stone-900">
                Overview
              </Link>
              <Link href="/agenda" className="hover:text-stone-900">
                Agenda tool
              </Link>
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
        <footer className="no-print mx-auto max-w-6xl px-6 pb-10 pt-4 text-xs text-stone-500">
          Two days, four halls, one honest score. No sign-up. No model scores your talk.
        </footer>
      </body>
    </html>
  );
}
