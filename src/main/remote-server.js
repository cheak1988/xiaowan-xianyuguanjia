'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
function createRemoteServer({ store, dispatch, directory = path.join(__dirname, '..', 'remote') }) {
  let server = null, status = { running: false }, revision = 0;
  const sessions = new Map(), attempts = new Map();
  const state = () => { const s = store.ready(); s.remoteUsers ||= []; return s; };
  const config = () => ({ enabled: false, host: '127.0.0.1', port: 17866, ...state().settings.remote });
  const publicUser = (user) => ({ id: user.id, name: user.name, role: user.role, account_ids: user.account_ids, disabled: !!user.disabled });
  function allowed(user, id) { return !!store.getAccount(Number(id)) && !store.getAccount(Number(id)).disabled && (user.role === 'admin' || user.account_ids.includes(Number(id))); }
  function accountIds(user) { return store.listAccounts().filter((account) => allowed(user, account.id)).map((account) => account.id); }
  function listUsers() { return state().remoteUsers.map(publicUser); }
  function revoke(id) { for (const [token, session] of sessions) if (session.userId === id) sessions.delete(token); }
  async function saveUser(input) {
    const users = state().remoteUsers, existing = input.id && users.find((user) => user.id === input.id);
    if (input.id && !existing) throw new Error('远程用户不存在');
    const name = String(input.name || '').trim();
    if (!/^[\p{L}\p{N}_@.\- ]{2,50}$/u.test(name) || users.some((user) => user.id !== input.id && user.name.toLowerCase() === name.toLowerCase())) throw new Error('用户名需2至50字且不能重复');
    if (!['admin', 'editor', 'viewer'].includes(input.role)) throw new Error('用户角色无效');
    let secret = {};
    if (!existing || input.password) {
      if (typeof input.password !== 'string' || input.password.length < 10 || input.password.length > 200) throw new Error('密码需10至200位');
      const salt = crypto.randomBytes(24).toString('hex');
      secret = { salt, password_hash: (await scrypt(input.password, salt, 64)).toString('hex') };
    }
    const ids = [...new Set((input.account_ids || []).map(Number))];
    if (ids.some((id) => !store.getAccount(id))) throw new Error('分配的店铺不存在');
    const row = { ...existing, id: existing?.id || crypto.randomUUID(), name, role: input.role, account_ids: ids, disabled: !!input.disabled, ...secret };
    if (existing) users[users.indexOf(existing)] = row; else users.push(row);
    store.persist(); revoke(row.id); return publicUser(row);
  }
  function removeUser(id) { state().remoteUsers = state().remoteUsers.filter((user) => user.id !== id); store.persist(); revoke(id); return true; }
  function sessionOf(request) {
    const token = /(?:^|;\s*)xy_remote=([a-f0-9]{64})(?:;|$)/.exec(request.headers.cookie || '')?.[1];
    const session = token && sessions.get(digest(token));
    if (!session || session.expires < Date.now()) { if (token) sessions.delete(digest(token)); return null; }
    const user = state().remoteUsers.find((row) => row.id === session.userId && !row.disabled);
    return user ? { user, session, token } : null;
  }
  async function bodyOf(request) {
    if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] || '')) throw Object.assign(new Error('仅接受JSON请求'), { code: 415 });
    const chunks = []; let size = 0;
    for await (const chunk of request) { size += chunk.length; if (size > 8 * 1024 * 1024) throw Object.assign(new Error('请求内容过大'), { code: 413 }); chunks.push(chunk); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  }
  function hosts() { return new Set(['localhost', '127.0.0.1', '[::1]', ...Object.values(os.networkInterfaces()).flat().filter(Boolean).map((row) => row.address)]); }
  async function handler(request, response) {
    response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: https://*.alicdn.com https://*.goofish.com https://*.taobaocdn.com; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    const json = (code, value) => { response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(value)); };
    try {
      const url = new URL(request.url, 'http://' + request.headers.host);
      if (!hosts().has(url.hostname)) return json(403, { ok: false, error: '访问地址未授权' });
      if (!['GET', 'POST'].includes(request.method)) return json(405, { ok: false, error: '请求方法无效' });
      if (request.method === 'POST' && request.headers.origin !== url.origin) return json(403, { ok: false, error: '请求来源无效' });
      if (url.pathname === '/api/login' && request.method === 'POST') {
        const ip = request.socket.remoteAddress, now = Date.now();
        if (attempts.size > 2000) for (const [key, attempt] of attempts) if (attempt.until < now) attempts.delete(key);
        let attempt = attempts.get(ip); if (!attempt || attempt.until < now) { attempt = { count: 0, until: now + 15 * 60000 }; attempts.set(ip, attempt); }
        if (++attempt.count > 12) return json(429, { ok: false, error: '登录尝试过多，请15分钟后重试' });
        const body = await bodyOf(request), name = String(body.name || '').trim().toLowerCase();
        const user = state().remoteUsers.find((row) => !row.disabled && row.name.toLowerCase() === name);
        if (typeof body.password !== 'string' || body.password.length > 200) return json(401, { ok: false, error: '用户名或密码错误' });
        const hash = await scrypt(body.password, user?.salt || 'invalid-user-salt', 64);
        if (!user || !crypto.timingSafeEqual(hash, Buffer.from(user.password_hash, 'hex'))) return json(401, { ok: false, error: '用户名或密码错误' });
        attempts.delete(ip);
        if (sessions.size >= 500) for (const [key, item] of sessions) if (item.expires < now) sessions.delete(key);
        if (sessions.size >= 500) return json(503, { ok: false, error: '在线会话已满' });
        const token = crypto.randomBytes(32).toString('hex'), csrf = crypto.randomBytes(24).toString('hex');
        sessions.set(digest(token), { userId: user.id, csrf, expires: now + 8 * 3600000 });
        response.setHeader('Set-Cookie', 'xy_remote=' + token + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800');
        return json(200, { ok: true, user: publicUser(user), csrf });
      }
      if (url.pathname.startsWith('/api/')) {
        const auth = sessionOf(request); if (!auth) return json(401, { ok: false, error: '请登录' });
        if (request.method === 'GET' && url.pathname === '/api/me') return json(200, { ok: true, user: publicUser(auth.user), csrf: auth.session.csrf });
        if (request.method !== 'POST' || request.headers['x-csrf-token'] !== auth.session.csrf) return json(403, { ok: false, error: '请求校验失败' });
        if (url.pathname === '/api/logout') { sessions.delete(digest(auth.token)); response.setHeader('Set-Cookie', 'xy_remote=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); return json(200, { ok: true }); }
        const body = await bodyOf(request);
        const currentUser = () => sessions.has(digest(auth.token)) && auth.session.expires >= Date.now() && state().remoteUsers.find((user) => user.id === auth.user.id && !user.disabled);
        const context = { user: publicUser(auth.user), accountIds: accountIds(auth.user), requireAccount(id) { const current = currentUser(); if (!current || !allowed(current, id)) throw Object.assign(new Error('无权访问该店铺'), { code: 403 }); return Number(id); }, requireWrite() { const current = currentUser(); if (!current || current.role === 'viewer') throw Object.assign(new Error('只读账号不能执行操作'), { code: 403 }); }, guard: (id) => { const current = currentUser(); return !!current && current.role !== 'viewer' && allowed(current, id); } };
        const result = await dispatch(url.pathname.slice(5), body, context);
        return json(200, result);
      }
      const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/tokens.css': ['../shell/vendor/semi/tokens.css', 'text/css'], '/goods-options.js': ['../shell/goods-options.js', 'text/javascript'] };
      const asset = assets[url.pathname]; if (!asset) return json(404, { ok: false, error: '页面不存在' });
      response.writeHead(200, { 'Content-Type': asset[1] + '; charset=utf-8' }); response.end(fs.readFileSync(path.join(directory, asset[0])));
    } catch (error) { if (!response.headersSent) json(error.code >= 400 && error.code <= 599 ? error.code : 400, { ok: false, error: error.message }); else response.end(); }
  }
  async function stop() { revision++; const previous = server; server = null; status = { running: false }; sessions.clear(); if (previous) { await new Promise((resolve) => { previous.close(resolve); for (const socket of previous.remoteSockets || []) socket.destroy(); }); } }
  async function start() {
    await stop(); const cfg = config(); if (!cfg.enabled) return status;
    const currentRevision = revision, current = http.createServer(handler); current.requestTimeout = 30000; current.headersTimeout = 10000; current.maxHeadersCount = 50;
    current.remoteSockets = new Set(); current.on('connection', (socket) => { current.remoteSockets.add(socket); socket.on('close', () => current.remoteSockets.delete(socket)); });
    current.on('clientError', (_error, socket) => socket.destroy());
    await new Promise((resolve, reject) => { current.once('error', reject); current.listen(cfg.port, cfg.host, resolve); });
    if (currentRevision !== revision) { current.close(); return status; }
    server = current; status = { running: true, host: cfg.host, port: current.address().port, urls: (cfg.host === '127.0.0.1' ? ['127.0.0.1'] : [...hosts()].filter((host) => !host.includes(':') && host !== 'localhost')).map((host) => `http://${host}:${current.address().port}`) };
    current.on('error', (error) => { status = { running: false, error: error.message }; }); return status;
  }
  async function configure(input) {
    if (!['127.0.0.1', '0.0.0.0'].includes(input.host) || !Number.isInteger(Number(input.port)) || Number(input.port) < 1024 || Number(input.port) > 65535) throw new Error('监听地址或端口无效（1024至65535）');
    if (input.enabled && !state().remoteUsers.some((user) => !user.disabled)) throw new Error('请先创建远程登录账号');
    state().settings.remote = { enabled: !!input.enabled, host: input.host, port: Number(input.port) }; store.persist();
    try { return await start(); } catch (error) { status = { running: false, error: error.message }; throw error; }
  }
  return { start, stop, configure, saveUser, removeUser, revoke, listUsers, config, status: () => status };
}
module.exports = { createRemoteServer };
