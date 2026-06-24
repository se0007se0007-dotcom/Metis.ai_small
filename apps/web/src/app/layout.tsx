import type { Metadata } from 'next';
import { Providers } from '@/lib/providers';
import './globals.css';

export const metadata: Metadata = {
  title: 'Metis.AI — AgentOps Governance Platform',
  description: 'Multi-tenant AgentOps governance, execution, and optimization SaaS',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body className="font-sans bg-dark text-white overflow-x-hidden">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
