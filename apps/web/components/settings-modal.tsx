'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Modal } from './modal';
import { ChevronIcon, SettingsIcon, PlusIcon } from './icons';
import type { ProviderConfig, ProviderProtocol, ModelEntry } from '@applepi/core';
import { REASONING_META, REASONING_KEYS } from '@/lib/display';

type ProviderMap = Record<string, ProviderConfig & { apiKey?: string }>;

const NAV = [
  { key: 'general', label: '通用设置' },
  { key: 'models', label: '模型' },
  { key: 'plugins', label: '插件' },
] as const;

const PROTOCOLS: ProviderProtocol[] = ['openai-completions', 'openai-responses', 'anthropic-messages'];

async function fetchJson(url: string, init?: RequestInit) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

export function SettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [nav, setNav] = useState<(typeof NAV)[number]['key']>('models');

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-900/30 p-4" onMouseDown={onClose}>
      <div
        className="flex h-[80vh] w-full max-w-3xl overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* left nav */}
        <aside className="w-44 shrink-0 border-r border-neutral-100 bg-neutral-50/60 p-3">
          <h2 className="px-2 py-1 text-sm font-semibold text-neutral-900">设置</h2>
          <nav className="mt-2 space-y-0.5">
            {NAV.map((n) => (
              <button
                key={n.key}
                onClick={() => setNav(n.key)}
                className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm ${
                  nav === n.key ? 'bg-neutral-200/70 font-medium text-neutral-900' : 'text-neutral-600 hover:bg-neutral-100'
                }`}
              >
                <SettingsIcon className="h-4 w-4 opacity-60" />
                {n.label}
              </button>
            ))}
          </nav>
        </aside>

        {/* right content */}
        <section className="flex min-w-0 flex-1 flex-col">
          <header className="flex items-center justify-between border-b border-neutral-100 px-5 py-3">
            <h3 className="text-sm font-semibold text-neutral-900">{NAV.find((n) => n.key === nav)?.label}</h3>
            <div className="flex items-center gap-2">
              {nav === 'models' && <OpenConfigButton />}
              <button onClick={onClose} className="rounded-md p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700" aria-label="关闭">
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M6 6l12 12M18 6 6 18" strokeLinecap="round" />
                </svg>
              </button>
            </div>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {nav === 'models' ? <ModelsPanel /> : <PlaceholderTab label={NAV.find((n) => n.key === nav)?.label ?? ''} />}
          </div>
        </section>
      </div>
    </div>,
    document.body,
  );
}

function PlaceholderTab({ label }: { label: string }) {
  return <p className="text-sm text-neutral-400">「{label}」暂未实现。</p>;
}

function OpenConfigButton() {
  const [hidden, setHidden] = useState(false);
  // Probe only (GET) — must NOT open the file on mount.
  useEffect(() => {
    fetchJson('/api/config/open-file')
      .then((r) => setHidden(!!r.hidden))
      .catch(() => setHidden(true));
  }, []);
  if (hidden) return null;
  return (
    <button
      onClick={() => fetch('/api/config/open-file', { method: 'POST' })}
      className="rounded-full border border-neutral-200 bg-white px-3 py-1 text-xs text-neutral-600 hover:bg-neutral-50"
    >
      打开配置文件
    </button>
  );
}

function ModelsPanel() {
  const [user, setUser] = useState<ProviderMap>({});
  const [available, setAvailable] = useState<{ id: string; displayName: string }[]>([]);
  const [lastUsed, setLastUsed] = useState<{ providerId: string; modelId: string } | undefined>();
  const [lastUsedLevel, setLastUsedLevel] = useState('medium');
  const [defaultPermissionLevel, setDefaultPermissionLevel] = useState('workspace');
  const [editing, setEditing] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = async () => {
    try {
      const d = await fetchJson('/api/config/providers');
      setUser(d.user ?? {});
      setAvailable(d.availableBuiltins ?? []);
      setLastUsed(d.lastUsedModel);
      setLastUsedLevel(d.lastUsedLevel ?? 'medium');
      setDefaultPermissionLevel(d.defaultPermissionLevel ?? 'workspace');
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    }
  };
  useEffect(() => {
    load();
  }, []);

  const saveReasoningLevel = async (level: string) => {
    await fetchJson('/api/config/last-used-level', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ level }),
    });
    setLastUsedLevel(level);
  };

  const saveDefaultPermission = async (level: string) => {
    await fetchJson('/api/config/general', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ permissionLevel: level }),
    });
    setDefaultPermissionLevel(level);
  };

  const saveAll = async (nextUser: ProviderMap) => {
    await fetchJson('/api/config/providers', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ providers: { ...nextUser }, lastUsedModel: lastUsed }),
    });
    await load();
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-neutral-500">填入各提供方的 API 密钥即可使用其模型。</p>
      {err && <p className="text-xs text-red-500">{err}</p>}

      {/* Reasoning level (global default) */}
      <div className="rounded-xl border border-neutral-200 px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="text-sm">
            <div className="font-medium text-neutral-900">推理等级</div>
            <div className="mt-0.5 text-xs text-neutral-400">新会话的默认思考强度，可在会话内单独覆盖</div>
          </div>
          <div className="flex items-center gap-1">
            {REASONING_KEYS.map((l) => {
              const label = REASONING_META[l].label;
              return (
                <button
                  key={l}
                  onClick={() => void saveReasoningLevel(l)}
                  className={`rounded-full border px-2.5 py-1 text-xs ${
                    lastUsedLevel === l
                      ? 'border-neutral-900 bg-neutral-900 font-medium text-white'
                      : 'border-neutral-200 text-neutral-600 hover:bg-neutral-50'
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Global default permission level (ADR-0016 通用设置) */}
      <div className="rounded-xl border border-neutral-200 px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="text-sm">
            <div className="font-medium text-neutral-900">默认权限级别</div>
            <div className="mt-0.5 text-xs text-neutral-400">新会话的默认安全级别，可在会话内单独覆盖</div>
          </div>
          <div className="flex items-center gap-1">
            {(['readonly', 'workspace', 'fullaccess'] as const).map((l) => {
              const label = { readonly: '只读', workspace: '工作区', fullaccess: '完全访问' }[l];
              return (
                <button
                  key={l}
                  onClick={() => void saveDefaultPermission(l)}
                  className={`rounded-full border px-2.5 py-1 text-xs ${
                    defaultPermissionLevel === l
                      ? 'border-neutral-900 bg-neutral-900 font-medium text-white'
                      : 'border-neutral-200 text-neutral-600 hover:bg-neutral-50'
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Only providers the user has enabled / added are shown. */}
      {Object.entries(user).map(([id, p]) => (
        <div key={id} className="flex items-center justify-between rounded-xl border border-neutral-200 px-4 py-3">
          <div className="flex items-center gap-2">
            <span className={`h-2 w-2 rounded-full ${p.apiKeyRef ? 'bg-green-500' : 'bg-neutral-300'}`} />
            <span className="text-sm font-medium text-neutral-900">{p.displayName}</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                setEditing(id);
                setFormOpen(true);
              }}
              className="rounded-full border border-neutral-200 px-3 py-1 text-xs text-neutral-600 hover:bg-neutral-50"
            >
              编辑
            </button>
            <button
              onClick={async () => {
                const next = { ...user };
                delete next[id];
                await saveAll(next);
              }}
              className="rounded-full px-3 py-1 text-xs text-red-500 hover:bg-red-50"
            >
              删除
            </button>
          </div>
        </div>
      ))}

      {Object.keys(user).length === 0 && !formOpen && (
        <p className="text-xs text-neutral-400">尚未添加任何提供方。点击下方「添加厂商」开始。</p>
      )}

      <button
        onClick={() => {
          setEditing(null);
          setFormOpen((o) => !o);
        }}
        className="flex items-center gap-1.5 rounded-full border border-neutral-200 px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-50"
      >
        <PlusIcon className="h-4 w-4" /> 添加厂商
      </button>

      {formOpen && (
        <ProviderForm
          user={user}
          availableBuiltins={available}
          initialId={editing}
          onCancel={() => {
            setFormOpen(false);
            setEditing(null);
          }}
          onSave={async (id, cfg) => {
            await saveAll({ ...user, [id]: cfg });
            setFormOpen(false);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}


function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-neutral-700">{label}</span>
      {children}
    </label>
  );
}

/**
 * Unified inline provider form (replaces the old ProviderCard + CustomProviderModal).
 * A single "提供方" picker at the top selects an existing/builtin provider or
 * "自定义提供方…" (free-text Provider ID entry). No modal — it renders inline.
 */
function ProviderForm({
  user,
  availableBuiltins,
  initialId,
  onCancel,
  onSave,
}: {
  user: ProviderMap;
  availableBuiltins: { id: string; displayName: string }[];
  initialId?: string | null;
  onCancel: () => void;
  onSave: (id: string, cfg: ProviderConfig & { apiKey?: string }) => void;
}) {
  const opts = [
    ...Object.keys(user).map((id) => ({ value: id, label: user[id].displayName ?? id })),
    ...availableBuiltins.map((b) => ({ value: b.id, label: b.displayName })),
    { value: '__custom__', label: '自定义提供方…' },
  ];
  const [selected, setSelected] = useState<string>(initialId ?? '');
  const isCustom = selected === '__custom__';

  const [id, setId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [baseURL, setBaseURL] = useState('');
  const [protocol, setProtocol] = useState<ProviderProtocol>('openai-completions');
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [showCustom, setShowCustom] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Re-seed the form fields whenever the chosen provider changes (or the
  // provider list updates), so re-opening an edited provider shows its saved
  // model catalog / baseURL instead of a blank form.
  useEffect(() => {
    if (isCustom) return;
    const pc = selected ? user[selected] : undefined;
    setModels(pc?.models ? [...pc.models] : []);
    setBaseURL(pc?.baseURL ?? '');
    setDisplayName(pc?.displayName ?? '');
    setProtocol(pc?.protocol ?? 'openai-completions');
  }, [selected, isCustom, user]);

  const idValid = /^[a-z][a-z0-9-]*$/.test(id);
  const idTaken = !isCustom && selected !== '__custom__' ? false : Object.keys(user).includes(id);

  const save = async () => {
    try {
      if (isCustom) {
        if (!idValid) throw new Error('Provider ID 须以小写字母开头，仅含 [a-z0-9-]');
        if (Object.keys(user).includes(id)) throw new Error('该 ID 已存在');
        if (!displayName) throw new Error('请填写显示名称');
        const cfg: ProviderConfig & { apiKey?: string } = {
          displayName,
          protocol,
          baseURL: baseURL || undefined,
          apiKeyRef: `PROVIDER_${id.toUpperCase().replace(/-/g, '_')}_API_KEY`,
          models: models.filter((m) => m.id),
          apiKey: apiKey || undefined,
        };
        await onSave(id, cfg);
      } else if (selected) {
        // builtin or existing user entry: keep its preset/overrides, only update key + models
        const existing = user[selected];
        const merged: ProviderConfig & { apiKey?: string } = {
          ...(existing as any),
          apiKeyRef: existing?.apiKeyRef ?? `PROVIDER_${selected.toUpperCase().replace(/-/g, '_')}_API_KEY`,
          models: models.filter((m) => m.id),
          apiKey: apiKey || undefined,
        };
        await onSave(selected, merged);
      } else {
        throw new Error('请选择或自定义一个提供方');
      }
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    }
  };

  return (
    <div className="space-y-3 rounded-xl border border-neutral-200 bg-neutral-50/50 p-4">
      <Field label="提供方">
        <select
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          className="w-full rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-sm"
        >
          <option value="" disabled>选择提供方或自定义…</option>
          {opts.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </Field>

      {isCustom && (
        <>
          <Field label="Provider ID">
            <input
              value={id}
              onChange={(e) => setId(e.target.value)}
              placeholder="acme-gateway"
              className="w-full rounded-lg border border-neutral-200 px-3 py-1.5 text-sm"
            />
            <span className="mt-1 block text-xs text-neutral-400">
              以小写字母开头的标识，在请求中唯一标识该提供方，并用于派生凭据名。
            </span>
            {!idValid && id && <span className="text-xs text-red-500">须以小写字母开头，仅含 [a-z0-9-]</span>}
            {idTaken && <span className="text-xs text-red-500">该 ID 已存在</span>}
          </Field>
          <Field label="显示名称">
            <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="显示名称" className="w-full rounded-lg border border-neutral-200 px-3 py-1.5 text-sm" />
          </Field>
          <Field label="API 地址">
            <input value={baseURL} onChange={(e) => setBaseURL(e.target.value)} placeholder="https://gateway.example/v1" className="w-full rounded-lg border border-neutral-200 px-3 py-1.5 text-sm" />
          </Field>
          <Field label="API 协议">
            <select value={protocol} onChange={(e) => setProtocol(e.target.value as ProviderProtocol)} className="w-full rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-sm">
              {PROTOCOLS.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </Field>
        </>
      )}

      <Field label="API 密钥">
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="输入 API 密钥，或留空使用环境认证"
          className="w-full rounded-lg border border-neutral-200 px-3 py-1.5 text-sm"
        />
      </Field>

      <div>
        <button onClick={() => setShowCustom((s) => !s)} className="flex items-center gap-1 text-sm text-neutral-600">
          <ChevronIcon className={`h-3 w-3 transition-transform ${showCustom ? 'rotate-180' : ''}`} /> 自定义设置
        </button>
        {showCustom && (
          <div className="mt-3 space-y-3">
            <Field label="API 地址">
              <input
                placeholder="提供方默认"
                value={baseURL}
                onChange={(e) => setBaseURL(e.target.value)}
                className="w-full rounded-lg border border-neutral-200 px-3 py-1.5 text-sm"
              />
            </Field>
            <div>
              <div className="mb-1 flex items-center justify-between">
                <span className="text-sm font-medium text-neutral-700">模型目录</span>
                <button
                  onClick={async () => {
                    if (selected === '__custom__' && protocol === 'anthropic-messages') return;
                    if (!selected) return;
                    setFetching(true);
                    try {
                      const r = await fetchJson(`/api/config/models?providerId=${encodeURIComponent(isCustom ? id : selected)}`);
                      setModels(r.models);
                    } catch (e: any) {
                      alert(e?.message ?? String(e));
                    } finally {
                      setFetching(false);
                    }
                  }}
                  disabled={(isCustom ? protocol === 'anthropic-messages' : false) || fetching || !selected}
                  className="text-xs text-blue-600 hover:underline disabled:text-neutral-400"
                >
                  {fetching ? '获取中…' : '获取可用模型'}
                </button>
              </div>
              <p className="text-xs text-neutral-400">正在使用适配器默认模型</p>
              <div className="mt-2 space-y-2">
                {models.map((m, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <input
                      value={m.id}
                      onChange={(e) => { const n = [...models]; n[i] = { ...m, id: e.target.value }; setModels(n); }}
                      placeholder="模型 ID"
                      className="w-full rounded-lg border border-neutral-200 px-2 py-1 text-xs"
                    />
                    <input
                      value={m.displayName}
                      onChange={(e) => { const n = [...models]; n[i] = { ...m, displayName: e.target.value }; setModels(n); }}
                      placeholder="显示名称"
                      className="w-full rounded-lg border border-neutral-200 px-2 py-1 text-xs"
                    />
                    <button onClick={() => setModels(models.filter((_, j) => j !== i))} className="text-red-400 hover:text-red-600" aria-label="删除模型">
                      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" strokeLinecap="round" strokeLinejoin="round" /></svg>
                    </button>
                  </div>
                ))}
              </div>
              <button onClick={() => setModels([...models, { id: '', displayName: '' }])} className="mt-2 rounded-full border border-neutral-200 px-3 py-1 text-xs text-neutral-600 hover:bg-neutral-50">
                添加模型
              </button>
            </div>
          </div>
        )}
      </div>

      {err && <p className="text-xs text-red-500">{err}</p>}

      <div className="flex justify-end gap-2 border-t border-neutral-100 pt-3">
        <button onClick={onCancel} className="rounded-full border border-neutral-200 px-4 py-1.5 text-sm text-neutral-600 hover:bg-neutral-50">取消</button>
        <button onClick={save} className="rounded-full bg-neutral-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-neutral-800">保存</button>
      </div>
    </div>
  );
}
