import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const source = await readFile(new URL('./web/app.js', import.meta.url), 'utf8');
function functionSource(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  const end = source.indexOf('\n}', start);
  assert.ok(end > start, name);
  return source.slice(start, end + 2);
}

test('legacy quotes retain their original source text, notes and stored labels', () => {
  const context = {};
  runInNewContext(['parseQuotedMessage', 'composeQuoted', 'displayQuoteLabel'].map(functionSource).join('\n'), context);
  const original = '> [用户] 今天的图片\n> 第二行\n【注】中文注释\n続き\n\n本文はそのまま';
  const parsed = context.parseQuotedMessage(original);
  assert.equal(parsed.quotes[0].label, '用户');
  assert.equal(parsed.quotes[0].text, '今天的图片\n第二行');
  assert.equal(parsed.quotes[0].note, '中文注释\n続き');
  assert.equal(parsed.body, '本文はそのまま');
  assert.equal(context.displayQuoteLabel(parsed.quotes[0].label), 'ユーザー');
  assert.equal(context.composeQuoted(parsed.quotes, parsed.body), original);
  assert.equal(context.displayQuoteLabel('工具·PowerShell'), 'ツール・PowerShell');
  assert.equal(context.displayQuoteLabel('モデルが付けた名前'), 'モデルが付けた名前');
});

test('read-aloud selects a Japanese voice even when Chinese and English precede it', () => {
  const voices = [{ lang: 'zh-CN' }, { lang: 'en-US' }, { lang: 'ja-JP' }, { lang: 'ja' }];
  const context = { TTS: {}, window: { speechSynthesis: true }, speechSynthesis: { getVoices: () => voices } };
  runInNewContext(functionSource('ttsPickVoice'), context);
  context.ttsPickVoice();
  assert.equal(context.TTS.voice, voices[2]);
  voices.splice(2, 1);
  context.ttsPickVoice();
  assert.equal(context.TTS.voice, voices[2]);
  voices.splice(2, 1);
  context.ttsPickVoice();
  assert.equal(context.TTS.voice, null);
});

test('read-aloud retains message text while replacing code and link placeholders', () => {
  const context = {};
  runInNewContext(functionSource('ttsPrepare'), context);
  const text = '今日は晴れ。中文内容\n```js\nsecret();\n```\nhttps://example.com\n![画像](https://example.com/image.png)';
  const prepared = context.ttsPrepare(text);
  assert.match(prepared, /今日は晴れ。中文内容/);
  assert.doesNotMatch(prepared, /secret\(\)|https:\/\/|图片|链接|代码/);
});
