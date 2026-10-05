/**
 * 图片上传这条链路的离线测试。
 *
 * 覆盖三个曾经各坏一处的地方（都在浏览器镜像层，内核其实早就支持多模态 content）：
 *
 *   1. `remote-session.prompt()` 只取字符串 → attachments 被整个丢弃，图片发不出去。
 *   2. `/api/message` 只认 text → 没人填 `user.message` 的 content。
 *   3. 渲染侧只画 text 块 → 标准的 pi-ai user 消息（content 里带 image 块）显示不出图。
 *
 * 加一条 SSE 帧体积的：图片内联在 messages 里，全量帧每 40ms 一帧，不剥会卡死页面。
 *
 * 全程离线：不需要 DOM（render 那条只验纯函数）、不打网络。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ContentParseError,
  base64ByteLength,
  contentText,
  hasImageBlock,
  isImageStub,
  parseUserContent,
  resolveImageStub,
  stubImageData,
  MAX_IMAGE_BYTES,
} from '../src/message-content';
import { createRemoteSession } from '../web/src/remote-session';
import { startServer, type RunningServer } from '../src/server';

/** 一张 1×1 PNG 的 base64（真图，够走通所有校验分支）。 */
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
/** 1×1 像素的 JPEG。 */
const JPEG_B64 = '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a';

// ─── message-content：纯函数 ───

test('parseUserContent：没有 content 返回 undefined（走纯文本老路）', () => {
  assert.equal(parseUserContent(undefined), undefined);
  assert.equal(parseUserContent(null), undefined);
  assert.equal(parseUserContent([]), undefined, '空数组等价于没有，别引入第二种状态形状');
});

test('parseUserContent：text 块原样收下', () => {
  const blocks = parseUserContent([{ type: 'text', text: '这张图里有几只猫？' }]);
  assert.deepEqual(blocks, [{ type: 'text', text: '这张图里有几只猫？' }]);
  assert.equal(contentText(blocks), '这张图里有几只猫？');
  assert.equal(hasImageBlock(blocks), false);
});

test('parseUserContent：图片块连同 mimeType 一起收下', () => {
  const blocks = parseUserContent([
    { type: 'text', text: '看看' },
    { type: 'image', data: PNG_B64, mimeType: 'image/png' },
  ]);
  assert.equal(blocks?.length, 2);
  assert.equal(hasImageBlock(blocks), true);
  const image = blocks?.[1];
  assert.equal(image?.type, 'image');
  if (image?.type === 'image') {
    assert.equal(image.data, PNG_B64);
    assert.equal(image.mimeType, 'image/png');
  }
});

test('parseUserContent：只有图没有字也是合法的（只发一张截图）', () => {
  const blocks = parseUserContent([{ type: 'image', data: PNG_B64, mimeType: 'image/png' }]);
  assert.equal(blocks?.length, 1);
  assert.equal(contentText(blocks), '', '没有文本可取，轨迹节点那边会退回「[图片 ×1]」');
  assert.equal(hasImageBlock(blocks), true);
});

test('parseUserContent：非 base64 的 image.data 报错，不许进 state', () => {
  assert.throws(
    () => parseUserContent([{ type: 'image', data: 'not base64!!', mimeType: 'image/png' }]),
    ContentParseError,
  );
  // 长度对但字符集不对也要拦住：base64ByteLength 会「算出」一个看似合理的字节数。
  assert.throws(
    () => parseUserContent([{ type: 'image', data: 'a'.repeat(400) + '!!!!', mimeType: 'image/png' }]),
    ContentParseError,
  );
});

test('parseUserContent：不支持的图片类型被拒（SVG / text / 缺 mimeType）', () => {
  for (const mimeType of ['image/svg+xml', 'text/html', '', undefined]) {
    assert.throws(
      () => parseUserContent([{ type: 'image', data: PNG_B64, mimeType }]),
      ContentParseError,
      `mimeType=${String(mimeType)} 应该被拒`,
    );
  }
});

test('parseUserContent：超限图片被拒（否则会话文件与 SSE 帧都会爆）', () => {
  // 每 4 个 base64 字符 = 3 字节。要超过 24MB，得造 32MB 字符的串。
  const huge = 'A'.repeat(Math.ceil((MAX_IMAGE_BYTES + 1) / 3) * 4);
  assert.ok(base64ByteLength(huge) > MAX_IMAGE_BYTES);
  assert.throws(
    () => parseUserContent([{ type: 'image', data: huge, mimeType: 'image/png' }]),
    ContentParseError,
  );
});

test('parseUserContent：mimeType 带参数也认，并归一成标准值', () => {
  const blocks = parseUserContent([
    { type: 'image', data: PNG_B64, mimeType: 'image/jpeg;base64' },
  ]);
  const image = blocks?.[0];
  if (image?.type === 'image') {
    assert.equal(image.mimeType, 'image/jpeg');
  }
  // image/jpg 是常见的历史写法，归一到 jpeg。
  const jpg = parseUserContent([{ type: 'image', data: JPEG_B64, mimeType: 'image/jpg' }]);
  const jpgImage = jpg?.[0];
  if (jpgImage?.type === 'image') {
    assert.equal(jpgImage.mimeType, 'image/jpeg');
  }
});

test('parseUserContent：结构不对时报错而不是静默丢', () => {
  assert.throws(() => parseUserContent({ type: 'text' }), ContentParseError);
  assert.throws(() => parseUserContent(['hello']), ContentParseError);
  assert.throws(() => parseUserContent([{ type: 'text' }]), ContentParseError, 'text 块缺 text');
  assert.throws(() => parseUserContent([{ type: 'image', mimeType: 'image/png' }]), ContentParseError);
});

test('parseUserContent：未知块类型被丢弃而不是让整条消息失败', () => {
  // 浏览器比内核新时可能带新块类型，拦住整个消息比丢一个块更糟。
  const blocks = parseUserContent([
    { type: 'text', text: 'hi' },
    { type: 'video', data: '...' },
  ]);
  assert.deepEqual(blocks, [{ type: 'text', text: 'hi' }]);
});

test('占位串：内容相同 → 占位相同；内容不同 → 占位不同', () => {
  // 这是「三处出现同一张图能被认出」的全部依据，所以要钉死。
  assert.equal(stubImageData(PNG_B64), stubImageData(PNG_B64));
  assert.notEqual(stubImageData(PNG_B64), stubImageData(JPEG_B64));
  assert.ok(isImageStub(stubImageData(PNG_B64)));
  assert.equal(isImageStub(PNG_B64), false, '真 base64 不能被误判成占位');
});

test('占位串：长度远小于原图（这才是剥图的意义）', () => {
  const stub = stubImageData('A'.repeat(2_000_000));
  assert.ok(stub.length < 40, `占位却有 ${stub.length} 字符`);
  assert.ok(stub.length < 'A'.repeat(2_000_000).length / 1000);
});

test('resolveImageStub：缓存命中换回真图，未命中返回空串而不是崩', () => {
  const stub = stubImageData(PNG_B64);
  const cache = new Map([[stub, PNG_B64]]);
  assert.equal(resolveImageStub(stub, 'image/png', cache), PNG_B64);
  // 没缓存到：返回空串，渲染侧会显示成「图丢了」，但界面不炸。
  assert.equal(resolveImageStub(stub, 'image/png', new Map()), '');
  // 非占位原样返回（首帧里的真图不该被当成占位）。
  assert.equal(resolveImageStub(PNG_B64, 'image/png', new Map()), PNG_B64);
});

// ─── remote-session：prompt() 到底往 /api/message 发了什么 ───

interface SentBody {
  text?: string;
  content?: { type: string; text?: string; data?: string; mimeType?: string }[];
}

function sessionWithSpy() {
  const sent: SentBody[] = [];
  const remote = createRemoteSession({
    eventsUrl: 'http://127.0.0.1:1/never', // 不连：这里只验 prompt 的出参
    fetchImpl: (async (url: string, init?: RequestInit) => {
      if (String(url).includes('/api/message')) {
        sent.push(JSON.parse(String(init?.body ?? '{}')) as SentBody);
      }
      return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch,
  });
  return { remote, sent };
}

test('Web：带图片的消息要真的把 content 发出去（这条曾经整个丢掉 attachments）', async () => {
  const { remote, sent } = sessionWithSpy();
  // pi-web-ui 带附件时的真实形状（见它的 AgentInterface.sendMessage）。
  await remote.prompt({
    role: 'user-with-attachments',
    content: '这张图里有几只猫？',
    attachments: [
      { id: 'a1', type: 'image', fileName: 'cat.png', mimeType: 'image/png', size: 10, content: PNG_B64, preview: PNG_B64 },
    ],
    timestamp: 1,
  });
  assert.equal(sent.length, 1);
  const body = sent[0]!;
  assert.equal(body.text, '这张图里有几只猫？');
  const content = body.content ?? [];
  assert.equal(content.length, 2, '一个 text 块 + 一个 image 块');
  assert.equal(content[0]?.type, 'text');
  assert.equal(content[1]?.type, 'image');
  assert.equal(content[1]?.data, PNG_B64, '图片数据必须原样送到内核');
  assert.equal(content[1]?.mimeType, 'image/png');
});

test('Web：只发图不写字也要发得出去（不能当成空消息丢掉）', async () => {
  const { remote, sent } = sessionWithSpy();
  await remote.prompt({
    role: 'user-with-attachments',
    content: '',
    attachments: [
      { id: 'a1', type: 'image', fileName: 'cat.png', mimeType: 'image/png', size: 10, content: PNG_B64 },
    ],
    timestamp: 1,
  });
  assert.equal(sent.length, 1);
  const content = sent[0]?.content ?? [];
  assert.equal(content.length, 1, '不该塞一个空 text 块');
  assert.equal(content[0]?.type, 'image');
});

test('Web：多张图 + 文档各自成块', async () => {
  const { remote, sent } = sessionWithSpy();
  await remote.prompt({
    role: 'user-with-attachments',
    content: '这两张图和这个文档',
    attachments: [
      { id: 'a1', type: 'image', fileName: '1.png', mimeType: 'image/png', size: 1, content: PNG_B64 },
      { id: 'a2', type: 'image', fileName: '2.png', mimeType: 'image/jpeg', size: 1, content: JPEG_B64 },
      { id: 'a3', type: 'document', fileName: 'note.md', mimeType: 'text/markdown', size: 1, content: 'AAA', extractedText: '# 标题' },
    ],
    timestamp: 1,
  });
  const content = sent[0]?.content ?? [];
  assert.deepEqual(content.map((b) => b.type), ['text', 'image', 'image', 'text']);
  const doc = content[3];
  assert.ok(doc?.text?.includes('[Document: note.md]'), '文档块要有文件名头，与 pi-web-ui 一致');
  assert.ok(doc?.text?.includes('# 标题'));
});

test('Web：没有附件时走老路（只发 text，不带 content 字段）', async () => {
  const { remote, sent } = sessionWithSpy();
  await remote.prompt('今天几号？');
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], { text: '今天几号？' });
  // deepEqual 已经验过「没有 content 键」，这里再点名一次：断言对象上没这个属性，
  // 而不是在解析结果上取一个不存在的键（那会红在类型上，不是红在行为上）。
  assert.ok(!('content' in (sent[0] as object)), '无附件时不要引入第二种形状');
});

test('Web：空白消息不发（老行为，别回归）', async () => {
  const { remote, sent } = sessionWithSpy();
  await remote.prompt('   ');
  assert.equal(sent.length, 0);
});

test('Web：发消息失败要走 onError，而不是抛一个没人 catch 的拒绝', async () => {
  const errors: string[] = [];
  const remote = createRemoteSession({
    eventsUrl: 'http://127.0.0.1:1/never',
    onError: (m) => errors.push(m),
    fetchImpl: (async (url: string) => {
      if (String(url).includes('/api/message')) {
        return new Response('{"error":"上一回合还没结束"}', {
          status: 409,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch,
  });
  await remote.prompt('在吗');
  assert.equal(errors.length, 1);
  assert.ok(errors[0]?.includes('上一回合还没结束'), `实际：${errors[0]}`);
});

test('Web：斜杠命令仍然不发 /api/message（附件也别把命令变成提问）', async () => {
  const sent: SentBody[] = [];
  const remote = createRemoteSession({
    eventsUrl: 'http://127.0.0.1:1/never',
    onCommand: async () => true, // 假装 /new 被处理了
    fetchImpl: (async (url: string, init?: RequestInit) => {
      if (String(url).includes('/api/message')) {
        sent.push(JSON.parse(String(init?.body ?? '{}')) as SentBody);
      }
      return new Response('{"ok":true}', { status: 200 });
    }) as unknown as typeof fetch,
  });
  await remote.prompt('/new');
  assert.equal(sent.length, 0);
});

// ─── 服务端：/api/message 真把 content 交给内核 ───

async function withServer(fn: (s: RunningServer) => Promise<void>): Promise<void> {
  const server = await startServer({ demo: true, traceDir: null, port: 0 });
  try {
    await fn(server);
  } finally {
    await server.close();
  }
}

test('服务端：带图的消息进 state.messages，content 块原样保留', async () => {
  await withServer(async (server) => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: '这张图里有几只猫？',
        content: [
          { type: 'text', text: '这张图里有几只猫？' },
          { type: 'image', data: PNG_B64, mimeType: 'image/png' },
        ],
      }),
    });
    assert.equal(res.status, 200);

    // 通过 /api/snapshot 看内核真收到了什么（faux provider 会自己答完，不用等）。
    const snap = (await (await fetch(`http://127.0.0.1:${server.port}/api/snapshot`)).json()) as {
      messages: { role: string; content: unknown }[];
    };
    const user = snap.messages.find((m) => m.role === 'user');
    assert.ok(user, '用户消息要进 messages');
    const content = user!.content as { type: string; data?: string }[];
    assert.ok(Array.isArray(content), 'content 应是块数组');
    assert.equal(content.filter((b) => b.type === 'image').length, 1, '图片块必须在内核里');
  });
});

test('服务端：畸形 content 回 400，且不进 state', async () => {
  await withServer(async (server) => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'hi',
        content: [{ type: 'image', data: 'not-base64!!', mimeType: 'image/png' }],
      }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.ok(body.error.includes('base64'), `实际：${body.error}`);

    const snap = (await (await fetch(`http://127.0.0.1:${server.port}/api/snapshot`)).json()) as {
      messages: unknown[];
      phase: string;
    };
    assert.equal(snap.messages.length, 0, '被拒的消息不能留下任何痕迹');
    assert.equal(snap.phase, 'idle', '也不能让环跑起来');
  });
});

test('服务端：只有图没文字也接受（text 缺省用 content 里的文本）', async () => {
  await withServer(async (server) => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: [{ type: 'image', data: PNG_B64, mimeType: 'image/png' }],
      }),
    });
    assert.equal(res.status, 200);
    const snap = (await (await fetch(`http://127.0.0.1:${server.port}/api/snapshot`)).json()) as {
      messages: { role: string; content: unknown }[];
    };
    const user = snap.messages.find((m) => m.role === 'user');
    const content = user?.content as { type: string }[];
    assert.equal(content.filter((b) => b.type === 'image').length, 1);
  });
});

test('服务端：空 content 且空 text 仍是 400（老行为）', async () => {
  await withServer(async (server) => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '   ' }),
    });
    assert.equal(res.status, 400);
  });
});

// ─── 帧里带不带真图：渲染能不能把图换回来 ───

/** 发一条带图的消息，等内核回到 idle（faux provider 会自己答完）。 */
async function sendImageAndWaitIdle(port: number): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${port}/api/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '图', content: [{ type: 'image', data: PNG_B64, mimeType: 'image/png' }] }),
  });
  assert.equal(res.status, 200);
  for (let i = 0; i < 200; i += 1) {
    const snap = (await (await fetch(`http://127.0.0.1:${port}/api/snapshot`)).json()) as {
      phase: string;
    };
    if (snap.phase === 'idle') return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('内核没回到 idle');
}

test('服务端：SSE 首帧与 /api/snapshot 都带真图（刷新后历史图不能只剩占位串）', async () => {
  await withServer(async (server) => {
    await sendImageAndWaitIdle(server.port);

    // /api/snapshot：刷新页面时浏览器拿全量状态的那一份。
    const snap = (await (await fetch(`http://127.0.0.1:${server.port}/api/snapshot`)).json()) as {
      messages: { role: string; content: { type: string; data?: string }[] }[];
    };
    const user = snap.messages.find((m) => m.role === 'user');
    const image = user?.content.find((b) => b.type === 'image');
    assert.ok(image, '用户消息里得有图');
    assert.equal(image.data, PNG_B64, 'snapshot 必须是真图，浏览器靠它填 imageCache');

    // SSE 首帧：每个新连接（重开标签页）都靠这一帧重建缓存。
    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${server.port}/api/events`, {
      signal: controller.signal,
    });
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    controller.abort();
    const first = JSON.parse(new TextDecoder().decode(value).replace(/^data: /, '')) as {
      messages: { role: string; content: { type: string; data?: string }[] }[];
    };
    const frameUser = first.messages.find((m) => m.role === 'user');
    const frameImage = frameUser?.content.find((b) => b.type === 'image');
    assert.equal(frameImage?.data, PNG_B64, 'SSE 首帧也必须是真图');
  });
});

test('服务端：广播帧把图折成占位串，但可被同一张图的首帧缓存换回', async () => {
  await withServer(async (server) => {
    await sendImageAndWaitIdle(server.port);
    const stub = stubImageData(PNG_B64);

    // 订阅 SSE（拿到带真图的首帧并填缓存），再发一条消息触发广播帧。
    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${server.port}/api/events`, {
      signal: controller.signal,
    });
    const reader = res.body!.getReader();
    const { value: firstRaw } = await reader.read();
    const first = JSON.parse(new TextDecoder().decode(firstRaw).replace(/^data: /, '')) as {
      messages: { role: string; content: { type: string; data?: string }[] }[];
    };
    const firstImage = first.messages.find((m) => m.role === 'user')?.content.find((b) => b.type === 'image');
    assert.equal(firstImage?.data, PNG_B64, '先确认首帧带真图');

    // 触发一次广播。
    await fetch(`http://127.0.0.1:${server.port}/api/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '再问一句' }),
    });

    // 读广播帧：找一帧**不含真图**的（剥图后体积很小，很快就会来）。
    let stripped = false;
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !stripped) {
      const { value, done } = await reader.read();
      if (done) break;
      const frame = JSON.parse(new TextDecoder().decode(value).replace(/^data: /, '')) as {
        messages: { role: string; content: { type: string; data?: string }[] }[];
      };
      for (const m of frame.messages) {
        for (const b of m.content) {
          if (b.type === 'image' && b.data !== PNG_B64) {
            assert.ok(isImageStub(b.data!), `广播帧里的图应该是占位串，实际：${b.data?.slice(0, 20)}`);
            // 关键是能换回同一张图 —— 浏览器就是靠这个显示的。
            assert.equal(
              resolveImageStub(b.data!, 'image/png', new Map([[b.data!, PNG_B64]])),
              PNG_B64,
            );
            stripped = true;
          }
        }
      }
    }
    controller.abort();
    assert.ok(stripped, '广播帧应该把 base64 折成占位串（否则一张 2MB 图会被反复传几百次）');
  });
});
