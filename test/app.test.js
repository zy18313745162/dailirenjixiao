'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApplication } = require('../server');

async function setup(t) {
  const app = createApplication({ dbPath: ':memory:', adminUsername: 'owner', adminPassword: 'A-very-strong-test-password-2026' });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(() => app.close());
  async function request(url, { cookie, csrf, ...opts } = {}) {
    const headers = { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(opts.headers || {}) };
    const response = await fetch(base + url, { ...opts, headers });
    const body = await response.json().catch(() => null);
    return { response, body, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  const login = async (username, password) => {
    const result = await request('/api/login', { method: 'POST', body: JSON.stringify({ username, password }) });
    return { ...result, csrf: result.body?.csrf };
  };
  return { app, base, request, login };
}

test('front-end shell and protected routes are served', async t => {
  const { request, base } = await setup(t);
  const home = await fetch(base + '/');
  assert.equal(home.status, 200);
  assert.match(await home.text(), /瓣朵酒店/);
  const unauthenticated = await request('/api/dashboard?month=2026-10');
  assert.equal(unauthenticated.response.status, 401);
});

test('self registration remains pending until an administrator approves it', async t => {
  const { request, login } = await setup(t);
  const signup = await request('/api/register', { method: 'POST', body: JSON.stringify({
    name: '新代理人', username: 'newagent', password: 'Agent-password-2026!'
  }) });
  assert.equal(signup.response.status, 201);
  assert.match(signup.body.message, /等待酒店管理员审核/);
  assert.equal((await login('newagent', 'Agent-password-2026!')).response.status, 401);

  const admin = await login('owner', 'A-very-strong-test-password-2026');
  const list = await request('/api/agents', { cookie: admin.cookie });
  const pending = list.body.agents.find(agent => agent.username === 'newagent');
  assert.ok(pending);
  assert.equal(pending.active, 0);

  const approved = await request(`/api/agents/${pending.id}`, { method: 'PUT', cookie: admin.cookie, csrf: admin.csrf,
    body: JSON.stringify({ active: true }) });
  assert.equal(approved.response.status, 200);
  assert.equal((await login('newagent', 'Agent-password-2026!')).response.status, 200);
  assert.equal((await request('/api/register', { method: 'POST', body: JSON.stringify({
    name: '重复账号', username: 'newagent', password: 'Agent-password-2026!'
  }) })).response.status, 409);
});

test('order commissions, re-ranking, individual/month-wide rates, CSRF and settlement freeze', async t => {
  const { request, login } = await setup(t);
  const auth = await login('owner', 'A-very-strong-test-password-2026');
  assert.equal(auth.response.status, 200);
  const sess = await request('/api/session', { cookie: auth.cookie });
  assert.equal(sess.response.status, 200);
  const agent = await request('/api/agents', { method: 'POST', cookie: auth.cookie, csrf: auth.csrf,
    body: JSON.stringify({ name: '林小雨', username: 'linxiaoyu', password: 'Agent-password-2026!' }) });
  assert.equal(agent.response.status, 201);

  for (let i = 0; i < 7; i++) {
    const created = await request('/api/orders', { method: 'POST', cookie: auth.cookie, csrf: auth.csrf,
      body: JSON.stringify({ agentId: agent.body.id, code: `ORD-${i + 1}`, amount: (i + 1) * 100,
        acceptedAt: `2026-10-${String(i + 1).padStart(2, '0')}T10:00`, status: 'valid' }) });
    assert.equal(created.response.status, 201);
  }
  const individual = await request('/api/rates', { method: 'PUT', cookie: auth.cookie, csrf: auth.csrf,
    body: JSON.stringify({ month: '2026-10', scope: 'single', agentId: agent.body.id, percentage: 5 }) });
  assert.equal(individual.response.status, 200);
  let data = await request('/api/dashboard?month=2026-10', { cookie: auth.cookie });
  assert.equal(data.body.totals.orders, 7);
  assert.equal(data.body.totals.commission, 250 + (600 + 700) * 0.05);
  assert.equal(data.body.orders.find(x => x.code === 'ORD-7').sequence, 7);

  const unauthorizedWrite = await request('/api/rates', { method: 'PUT', cookie: auth.cookie,
    body: JSON.stringify({ month: '2026-10', scope: 'all', percentage: 4 }) });
  assert.equal(unauthorizedWrite.response.status, 403);

  const canceled = await request(`/api/orders/${data.body.orders.find(x => x.code === 'ORD-2').id}`, { method: 'PUT', cookie: auth.cookie, csrf: auth.csrf,
    body: JSON.stringify({ status: 'cancelled' }) });
  assert.equal(canceled.response.status, 200);
  data = await request('/api/dashboard?month=2026-10', { cookie: auth.cookie });
  assert.equal(data.body.totals.orders, 6);
  assert.equal(data.body.orders.find(x => x.code === 'ORD-7').sequence, 6);
  assert.equal(data.body.orders.find(x => x.code === 'ORD-7').commission, 35);

  const bulk = await request('/api/rates', { method: 'PUT', cookie: auth.cookie, csrf: auth.csrf,
    body: JSON.stringify({ month: '2026-10', scope: 'all', percentage: 4 }) });
  assert.equal(bulk.response.status, 200);
  const settled = await request('/api/settlements', { method: 'POST', cookie: auth.cookie, csrf: auth.csrf,
    body: JSON.stringify({ month: '2026-10' }) });
  assert.equal(settled.response.status, 201);
  const blockedRate = await request('/api/rates', { method: 'PUT', cookie: auth.cookie, csrf: auth.csrf,
    body: JSON.stringify({ month: '2026-10', scope: 'single', agentId: agent.body.id, percentage: 9 }) });
  assert.equal(blockedRate.response.status, 409);
  const blockedOrder = await request('/api/orders', { method: 'POST', cookie: auth.cookie, csrf: auth.csrf,
    body: JSON.stringify({ agentId: agent.body.id, code: 'AFTER-SETTLE', amount: 1, acceptedAt: '2026-10-31T10:00', status: 'valid' }) });
  assert.equal(blockedOrder.response.status, 409);
});

test('agent account is scoped to own orders and submissions require review', async t => {
  const { request, login } = await setup(t);
  const admin = await login('owner', 'A-very-strong-test-password-2026');
  const created = await request('/api/agents', { method: 'POST', cookie: admin.cookie, csrf: admin.csrf,
    body: JSON.stringify({ name: '陈可欣', username: 'chenkexin', password: 'Agent-password-2026!' }) });
  const otherCreated = await request('/api/agents', { method: 'POST', cookie: admin.cookie, csrf: admin.csrf,
    body: JSON.stringify({ name: '另一代理', username: 'anotheragent', password: 'Agent-password-2026!' }) });
  const rate = await request('/api/rates', { method: 'PUT', cookie: admin.cookie, csrf: admin.csrf,
    body: JSON.stringify({ month: '2026-10', scope: 'all', percentage: 4 }) });
  assert.equal(rate.response.status, 200);
  const agent = await login('chenkexin', 'Agent-password-2026!');
  assert.equal(agent.response.status, 200);
  const post = await request('/api/orders', { method: 'POST', cookie: agent.cookie, csrf: agent.csrf,
    body: JSON.stringify({ agentId: created.body.id, code: 'AGENT-ORDER', amount: 320.5, acceptedAt: '2026-10-03T11:20', status: 'valid' }) });
  assert.equal(post.response.status, 201);
  const data = await request('/api/dashboard?month=2026-10&agentId=someone-else', { cookie: agent.cookie });
  assert.equal(data.body.orders.length, 1);
  assert.equal(data.body.orders[0].status, 'pending');
  assert.equal(data.body.orders[0].agent_id, created.body.id);
  assert.deepEqual(data.body.rates, []);
  assert.deepEqual(data.body.audit, []);
  assert.equal(data.body.summaries.length, 1);
  assert.notEqual(data.body.summaries[0].id, otherCreated.body.id);
  const forbidden = await request('/api/rates?month=2026-10', { cookie: agent.cookie });
  assert.equal(forbidden.response.status, 403);
  const weak = await request('/api/agents', { method: 'POST', cookie: admin.cookie, csrf: admin.csrf,
    body: JSON.stringify({ name: '弱口令', username: 'weakpass', password: 'short' }) });
  assert.equal(weak.response.status, 400);
});

test('month and money validation rejects malformed input', async t => {
  const { request, login } = await setup(t), admin = await login('owner', 'A-very-strong-test-password-2026');
  assert.equal((await request('/api/dashboard?month=2026-13', { cookie: admin.cookie })).response.status, 400);
  const agent = await request('/api/agents', { method: 'POST', cookie: admin.cookie, csrf: admin.csrf,
    body: JSON.stringify({ name: '代理', username: 'agent1', password: 'Agent-password-2026!' }) });
  const bad = await request('/api/orders', { method: 'POST', cookie: admin.cookie, csrf: admin.csrf,
    body: JSON.stringify({ agentId: agent.body.id, code: 'BAD', amount: -5, acceptedAt: '2026-10-01T10:00' }) });
  assert.equal(bad.response.status, 400);
  const impossibleDate = await request('/api/orders', { method: 'POST', cookie: admin.cookie, csrf: admin.csrf,
    body: JSON.stringify({ agentId: agent.body.id, code: 'BAD-DATE', amount: 5, acceptedAt: '2026-02-30T10:00' }) });
  assert.equal(impossibleDate.response.status, 400);
});

