import type { Metadata } from 'next';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import '../styles/tokens.css';
import { Sidebar } from '../components/layout/sidebar';
import { StoreProvider } from '../components/providers/store-provider';

export const metadata: Metadata = {
  title: 'SeedPulse',
  description: 'AI Agent Orchestrator Dashboard',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body className="flex min-h-screen">
        <StoreProvider>
          <Sidebar />
          <main className="flex-1 ml-[120px] p-6">{children}</main>
        </StoreProvider>
      </body>
    </html>
  );
}
