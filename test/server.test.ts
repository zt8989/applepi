import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer, type RunningServer } from '../src/server';
import { createKernel } from '../src/kernel';
import { getTool } from '../src/tools';

/**
 * 服务端这一层的测试。
 *
 * 重点验证「内核只有一份」这件事在架构上是真的：浏览器发消息 → Node 跑环 → SSE 回状态。
 * 全程离线（faux provider），不碰网络。
 */

async function withServer(
  fn: (server: RunningServer, cwd: string) => Promise<void>,
  options: Parameters<typeof startServer>[0] = {},
): Promise<void> {
  const server = await startServer({
    demo: true,
    traceDir: null,
    port: 0, // 让系统分配空闲端口
    ...options,
  });
  try {
    await fn(server, path.resolve(options.cwd ?? process.cwd()));
  } finally {
    await server.close();
  }
}

test('GET /api/snapshot：首次进入拿到全量状态', async () => {
  await withServer(async (server) => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/snapshot`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body['type'], 'snapshot');
    assert.equal(body['phase'], 'idle');
    assert.deepEqual(body['messages'], []);
    assert.ok(body['trace'], '轨迹树要一起给过去（界面要画它）');
    assert.equal(body['needsApiKey'], false, 'faux 不需要 key，浏览器就不该弹窗');
  });
});

test('POST /api/message → 环真的跑起来 → SSE 推状态', async () => {
  await withServer(async (server) => {
    // 先订阅，攒帧。
    const controller = new AbortController();
    const frames: { phase?: string; messages?: unknown[]; turns?: number }[] = [];
    const done = (async () => {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/events`, {
        signal: controller.signal,
      });
      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (reader) {
        const { done: finished, value } = await reader.read();
        if (finished) break;
        buffer += decoder.decode(value, { stream: true });
        let index = buffer.indexOf('\n\n');
        while (index >= 0) {
          const chunk = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const line = chunk.split('\n').find((l) => l.startsWith('data: '));
          if (line) frames.push(JSON.parse(line.slice(6)) as never);
          index = buffer.indexOf('\n\n');
        }
      }
    })();

    // 等首帧到达。
    await new Promise((resolve) => setTimeout(resolve, 300));

    const sendRes = await fetch(`http://127.0.0.1:${server.port}/api/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '算一下 (3+4)*6' }),
    });
    assert.equal(sendRes.status, 200);

    // 等环跑完。
    for (let i = 0; i < 60; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      const last = frames[frames.length - 1];
      if (last?.phase === 'idle' && (last.messages?.length ?? 0) > 0) break;
    }
    controller.abort();
    await done.catch(() => undefined);

    const last = frames[frames.length - 1];
    assert.ok(last, '至少收到一帧');
    assert.equal(last.phase, 'idle');
    assert.deepEqual(
      (last.messages ?? []).map((m) => (m as { role: string }).role),
      ['user', 'assistant', 'toolResult', 'assistant'],
      '环跑完一整条：用户 → 助手 → 工具 → 助手',
    );
    assert.ok(frames.length > 1, '状态变化过程中推送了多帧，不只是首帧');
  });
});

test('POST /api/message：上一回合没跑完时拒绝（409），不会双跑', async () => {
  await withServer(
    async (server) => {
      // 先手动把相位占住，模拟「正在跑」。
      server.kernel.store.dispatch({ type: 'agent.run' });
      const res = await fetch(`http://127.0.0.1:${server.port}/api/message`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '再来一条' }),
      });
      assert.equal(res.status, 409, '环在跑时必须拒绝，否则会双跑');
    },
    // 给一个很长的超时，让它保持 thinking 状态。
    { llmTimeoutMs: 60_000 },
  );
});

test('GET /api/tools：工具清单带 cwd 边界', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'kernel-cwd-'));
  try {
    await withServer(
      async (server) => {
        const res = await fetch(`http://127.0.0.1:${server.port}/api/tools`);
        const body = (await res.json()) as { cwd: string; tools: { name: string }[] };
        assert.equal(body.cwd, path.resolve(dir));
        assert.deepEqual(
          body.tools.map((t) => t.name),
          ['read', 'write', 'edit', 'bash'],
          '四个官方工具都在',
        );
      },
      { cwd: dir },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('静态文件：提供 index.html，且挡住目录穿越', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'kernel-web-'));
  try {
    await writeFile(path.join(dir, 'index.html'), '<html>ok</html>', 'utf8');
    await writeFile(path.join(dir, 'secret.txt'), 'top secret', 'utf8');
    await withServer(
      async (server) => {
        const ok = await fetch(`http://127.0.0.1:${server.port}/`);
        assert.equal(ok.status, 200);
        assert.match(await ok.text(), /ok/);

        // 目录穿越：路径解析后必须仍在 webRoot 内。
        const escape = await fetch(
          `http://127.0.0.1:${server.port}/..%2Fsecret.txt`,
          { redirect: 'manual' },
        );
        assert.notEqual(escape.status, 200, '目录穿越必须挡住');
      },
      // webRoot 显式指到 dir（默认是 <cwd>/web/dist）。
      { cwd: dir, webRoot: dir },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('工具真的摸文件系统：read/write/bash 走真实 IO，且受 cwd 约束', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'kernel-io-'));
  try {
    await writeFile(path.join(dir, 'hello.txt'), 'from-disk', 'utf8');
    const kernel = createKernel({
      provider: 'deepseek',
      systemPrompt: 't',
      cwd: dir,
      demo: true,
      traceDir: null,
    });
    try {
      const read = getTool('read', dir);
      const got = await read!.execute('c1', { path: 'hello.txt' } as never);
      assert.match(String((got.content[0] as { text?: string } | undefined)?.text), /from-disk/);

      const write = getTool('write', dir);
      await write!.execute('c2', { path: 'new.txt', content: 'written' } as never);
      assert.equal(await readFile(path.join(dir, 'new.txt'), 'utf8'), 'written', '真写盘了');

      const bash = getTool('bash', dir);
      const out = await bash!.execute('c3', { command: 'echo $(((3+4)*6))' } as never);
      assert.match(String((out.content[0] as { text?: string } | undefined)?.text), /42/, '真起了子进程');
    } finally {
      kernel.dispose();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('TUI 与 Web 共用同一个内核装配函数（架构上只有一份环）', async () => {
  // 这条测试是「声明」：两个入口都调 createKernel，没有第二处装配。
  const kernel = createKernel({
    provider: 'deepseek',
    systemPrompt: 't',
    cwd: process.cwd(),
    demo: true,
    traceDir: null,
  });
  try {
    assert.ok(kernel.store, '内核就是一个 store');
    // 环能起来。
    kernel.store.dispatch({ type: 'user.message', text: 'hi' });
    for (let i = 0; i < 50; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (kernel.store.getState().phase === 'idle' && kernel.store.getState().turns > 0) break;
    }
    const state = kernel.store.getState();
    assert.equal(state.turns, 2);
    assert.ok(state.trace.order.length > 0, '轨迹树也在');
  } finally {
    kernel.dispose();
  }
});
