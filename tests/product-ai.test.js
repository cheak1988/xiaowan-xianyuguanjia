'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { fixture } = require('./helpers');

function setup(t) {
  const f = fixture(t, { electron: {} });
  f.store.setSafeStorage({ isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from('fixture:' + value), decryptString: (value) => value.toString().slice(8) });
  f.ai = f.load('src/main/product-ai.js');
  return f;
}

test('商品 AI 配置与客服独立，密钥加密保存且不回传，留空不覆盖', (t) => {
  const f = setup(t), reply = JSON.stringify(f.store.getSettings().ai);
  const result = f.ai.save({ baseURL: 'https://example.test/v1/chat/completions', model: 'custom-model', apiKey: 'fixture-private-key', systemPrompt: '自然口语' });
  assert.equal(result.config.baseURL, 'https://example.test/v1'); assert.equal(result.config.apiKeySet, true);
  assert.equal(JSON.stringify(result).includes('fixture-private-key'), false); assert.equal(Object.hasOwn(result.config, 'apiKeyEnc'), false);
  assert.ok(f.store.getSettings().productAI.apiKeyEnc.startsWith('enc:'));
  f.ai.save({ ...result.config, apiKey: '' }); assert.equal(f.store.getProductAiKey(), 'fixture-private-key');
  assert.equal(JSON.stringify(f.store.getSettings().ai), reply);
  f.ai.save({ ...result.config, clearKey: true }); assert.equal(f.store.getProductAiKey(), '');
});

test('商品 AI 拒绝无效接口、空模型和超长文案，不把异常输出写进编辑器', (t) => {
  const { ai } = setup(t);
  assert.throws(() => ai.endpoint('file:///tmp/key'), /HTTP/);
  assert.throws(() => ai.endpoint('https://key@example.test/v1'), /HTTP/);
  assert.throws(() => ai.save({ baseURL: 'http://localhost:11434/v1', model: '' }), /模型/);
  assert.throws(() => ai.parseCopy('hello'), /有效/);
  assert.throws(() => ai.parseCopy('{"title":"","description":"正文"}'), /为空/);
  assert.throws(() => ai.parseCopy(JSON.stringify({ title: '字'.repeat(61), description: '详情' })), /字数/);
  const copy = ai.parseCopy('```json\n{"title":"收纳盒","description":"按实际尺寸选择。"}\n```');
  assert.equal(copy.title, '收纳盒');
});

test('自定义免 Key 接口实际请求成功，只提交商品关键词和资料，客服保持关闭', async (t) => {
  const f = setup(t), requests = [];
  const server = http.createServer(async (request, response) => {
    const chunks = []; for await (const part of request) chunks.push(part);
    requests.push({ path: request.url, authorization: request.headers.authorization, body: JSON.parse(Buffer.concat(chunks)) });
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ title: '电竞队徽设计 俱乐部 Logo 定制', description: '根据提供的设计需求沟通风格和内容。' }) } }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  f.ai.save({ baseURL: `http://127.0.0.1:${server.address().port}/v1`, model: 'local-model' });
  const result = await f.ai.generate({ keyword: '电竞队徽', facts: '只包含队徽设计，不含印刷。' });
  assert.equal(result.ok, true, result.error); assert.match(result.title, /队徽/);
  assert.equal(requests[0].path, '/v1/chat/completions'); assert.equal(requests[0].authorization, undefined);
  const facts = JSON.parse(requests[0].body.messages[1].content); assert.equal(facts.facts, '只包含队徽设计，不含印刷。');
  assert.equal(f.store.getSettings().ai.enabled, false); assert.equal(f.store.listProducts().length, 0);
});

test('接口拒绝会隐藏响应中回显的密钥，失败不冒充生成成功', async (t) => {
  const f = setup(t);
  const server = http.createServer((_request, response) => { response.writeHead(401); response.end('invalid fixture-private-key'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  f.ai.save({ baseURL: `http://127.0.0.1:${server.address().port}/v1`, model: 'custom-model', apiKey: 'fixture-private-key' });
  const result = await f.ai.generate({ keyword: '收纳盒' }); assert.equal(result.ok, false);
  assert.equal(result.error.includes('fixture-private-key'), false); assert.match(result.error, /401/);
});
