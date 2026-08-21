import type { Metadata } from 'next';
import './globals.css';
import { SettingsProvider } from '@/components/settings-provider';

export const metadata: Metadata = {
  title: 'applepi web chat',
  description: 'assistant-ui + Vercel AI SDK useChat + Langfuse',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <SettingsProvider>{children}</SettingsProvider>
      </body>
    </html>
  );
}
