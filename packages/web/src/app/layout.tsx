import { ClerkProvider } from '@clerk/nextjs';
import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Scrima — AI Coaching for Valorant',
  description:
    'Get personalized AI coaching from every Valorant match. Scrima analyzes your deaths, identifies patterns, and helps you improve — automatically.',
  icons: {
    icon: [
      { url: '/favicon-32x32.png', sizes: '32x32', type: 'image/png' },
      { url: '/favicon-16x16.png', sizes: '16x16', type: 'image/png' },
    ],
    apple: '/apple-touch-icon.png',
  },
  openGraph: {
    title: 'Scrima — AI Coaching for Valorant',
    description:
      'Get personalized AI coaching from every Valorant match. Automatic death analysis, coaching reports, and improvement tracking.',
    type: 'website',
    locale: 'en_US',
    siteName: 'Scrima',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Scrima — AI Coaching for Valorant',
    description: 'AI that watches your Valorant matches and coaches you to improve.',
  },
  robots: {
    index: true,
    follow: true,
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ClerkProvider
      appearance={{
        variables: {
          colorPrimary: '#7C3AED',
          colorBackground: '#0D1221',
          colorText: '#E8EFFF',
        },
      }}
    >
      <html lang="en">
        <body className="min-h-screen antialiased">{children}</body>
      </html>
    </ClerkProvider>
  );
}
