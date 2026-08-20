import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'applepi web chat',
  description: 'assistant-ui + Vercel AI SDK useChat + Langfuse',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
