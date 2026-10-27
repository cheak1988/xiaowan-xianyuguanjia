'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { fixture } = require('./helpers');
async function proxy(t, status=200) {
  const calls=[];
  const server=http.createServer(async (req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    calls.push({path:req.url,authorization:req.headers.authorization,body:JSON.parse(Buffer.concat(chunks))});
    res.writeHead(status,{'Content-Type':'application/json'});
    res.end(status===200?JSON.stringify({model:'fixture',choices:[{message:{content:'连接成功'}}]}):'invalid fixture-secret');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  return {calls,url:`http://127.0.0.1:${server.address().port}/v1`};
}
test('测试当前未保存的地址、模型和 Key，且不打开客服自动回复',async t=>{
  const f=fixture(t),ai=f.load('src/main/ai.js'),p=await proxy(t);
  const before=JSON.stringify(f.store.getSettings().ai);
  const result=await ai.test({baseURL:p.url,model:'deepseek-v4.1-flash',apiKey:'fixture-secret',temperature:0,systemPrompt:'只回复连接成功'});
  assert.equal(result.ok,true,result.error);assert.equal(result.reply,'连接成功');
  assert.equal(p.calls[0].path,'/v1/chat/completions');assert.equal(p.calls[0].authorization,'Bearer fixture-secret');
  assert.equal(p.calls[0].body.model,'deepseek-v4.1-flash');assert.equal(p.calls[0].body.temperature,0);
  assert.equal(JSON.stringify(f.store.getSettings().ai),before);
  assert.equal((await ai.chat({userText:'在吗'})).error,'AI 未启用');
});
test('已保存 Key 可留空复用，完整聊天接口地址不重复拼接',async t=>{
  const f=fixture(t),ai=f.load('src/main/ai.js'),p=await proxy(t);
  f.store.setSafeStorage({isEncryptionAvailable:()=>true,encryptString:v=>Buffer.from(v),decryptString:v=>v.toString()});
  f.store.setAiKey('fixture-secret');
  const result=await ai.test({baseURL:p.url+'/chat/completions/',model:'local-model',apiKey:''});
  assert.equal(result.ok,true,result.error);assert.equal(p.calls[0].path,'/v1/chat/completions');assert.equal(p.calls[0].authorization,'Bearer fixture-secret');
});
test('本机免 Key 服务可连接，认证失败不泄露 Key',async t=>{
  const f=fixture(t),ai=f.load('src/main/ai.js'),p=await proxy(t),fail=await proxy(t,401);
  assert.equal((await ai.test({baseURL:p.url,model:'local',apiKey:''})).ok,true);
  assert.equal(p.calls[0].authorization,undefined);
  const result=await ai.test({baseURL:fail.url,model:'local',apiKey:'fixture-secret'});
  assert.equal(result.ok,false);assert.match(result.error,/401/);assert.equal(JSON.stringify(result).includes('fixture-secret'),false);
  assert.match((await ai.test({baseURL:'file:///etc/passwd',model:'local'})).error,/接口地址无效/);
});
