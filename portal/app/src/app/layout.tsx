import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'ClawBridge Portal',
  description: 'ClawBridge Agent Client Portal',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-[#1f1f21] text-[#F5F5F7]">{children}</body>
    </html>
  );
}
