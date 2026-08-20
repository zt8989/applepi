import Link from 'next/link';

export default function SettingsPage() {
  return (
    <div className="flex h-dvh flex-col items-center justify-center bg-white text-neutral-900">
      <h1 className="text-2xl font-semibold">设置</h1>
      <p className="mt-2 text-sm text-neutral-500">设置面板占位页</p>
      <Link
        href="/"
        className="mt-6 rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800"
      >
        返回对话
      </Link>
    </div>
  );
}
