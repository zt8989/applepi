'use client';

import { useChatStore } from '@/lib/chat-store';
import { ChatUI } from '@/components/chat-ui';

export default function Page() {
  const store = useChatStore();
  return <ChatUI store={store} />;
}
