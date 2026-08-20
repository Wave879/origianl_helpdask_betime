import './globals.css';
import type { ReactNode } from 'react';

export const metadata = {
  title: 'Helpdesk Next',
  description: 'Helpdesk V2 migration shell',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="th">
      <body>{children}</body>
    </html>
  );
}
