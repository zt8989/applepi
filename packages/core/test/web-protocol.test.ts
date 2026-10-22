import test from 'node:test';
import assert from 'node:assert/strict';
import { parseClientMessage } from '../src/web-protocol';

/**
 * `parseClientMessage()` 是浏览器 → 服务端那道**校形门**。
 *
 * 它把认得的字段抄进一个新对象，所以**漏抄一个字段 = 那个功能静默消失**。
 * 附件就是这样漏过一次：浏览器把 `attachments` 发出去了，桥与内核却只收到文字
 * （e2e 里模型回「没有附带任何图片」才发现的）。
 */

test('parseClientMessage：prompt 的附件要被抄进来（图片 / 文档，其余字段丢掉）', () => {
  const message = parseClientMessage(
    JSON.stringify({
      type: 'prompt',
      text: '看图',
      attachments: [
        {
          id: '1',
          type: 'image',
          fileName: 'a.png',
          mimeType: 'image/png',
          size: 3,
          content: 'AAA',
          preview: 'AAA',
        },
        {
          id: '2',
          type: 'document',
          fileName: 'b.pdf',
          mimeType: 'application/pdf',
          size: 9,
          content: 'BBB',
          extractedText: '正文',
        },
      ],
    }),
  );
  assert.deepEqual(message, {
    type: 'prompt',
    text: '看图',
    attachments: [
      { id: '1', type: 'image', fileName: 'a.png', mimeType: 'image/png', size: 3, content: 'AAA' },
      {
        id: '2',
        type: 'document',
        fileName: 'b.pdf',
        mimeType: 'application/pdf',
        size: 9,
        content: 'BBB',
        extractedText: '正文',
      },
    ],
  });
});

test('parseClientMessage：不认识的附件条目丢掉；没有可用附件就当没带', () => {
  // 不认识的 type / 缺文件名 / 缺 MIME 一律丢 —— 与其余客户端消息同一条规矩。
  const filtered = parseClientMessage(
    JSON.stringify({
      type: 'prompt',
      text: '你好',
      attachments: [
        { id: 'v', type: 'video', fileName: 'c.mp4', mimeType: 'video/mp4', content: 'CCC' },
        { id: 'n', type: 'image', fileName: '', mimeType: 'image/png', content: 'DDD' },
        { id: 'm', type: 'image', fileName: 'd.png', mimeType: '', content: 'EEE' },
      ],
    }),
  );
  assert.deepEqual(filtered, { type: 'prompt', text: '你好' });

  // 缺省 / 空数组都不多带一个 `attachments: undefined` 字段（形状与旧版一致）。
  assert.deepEqual(parseClientMessage('{"type":"prompt","text":"你好"}'), {
    type: 'prompt',
    text: '你好',
  });
  assert.deepEqual(parseClientMessage('{"type":"prompt","text":"你好","attachments":[]}'), {
    type: 'prompt',
    text: '你好',
  });
});

test('parseClientMessage：text 不是字符串就整条丢掉（附件的 text 允许空串）', () => {
  assert.equal(parseClientMessage('{"type":"prompt"}'), undefined);
  assert.equal(parseClientMessage('{"type":"prompt","text":42}'), undefined);
  assert.deepEqual(parseClientMessage('{"type":"prompt","text":""}'), { type: 'prompt', text: '' });
});

test('parseClientMessage：continue / compact 只认形状（多余字段丢掉）', () => {
  // 续跑与压缩都不带参数：`/continue 继续`、`/compact 现在` 里那个人话 arg 不该变成协议字段。
  assert.deepEqual(parseClientMessage('{"type":"continue"}'), { type: 'continue' });
  assert.deepEqual(parseClientMessage('{"type":"continue","text":"继续"}'), { type: 'continue' });
  assert.equal(parseClientMessage('{"type":"Continue"}'), undefined);
  assert.deepEqual(parseClientMessage('{"type":"compact"}'), { type: 'compact' });
  assert.deepEqual(parseClientMessage('{"type":"compact","reason":"threshold"}'), {
    type: 'compact',
  });
});
