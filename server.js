'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { validMonth, normalizeStatus, computeMonth, summarize } = require('./domain');

const ROOT = __dirname;
const COOKIE_NAME = 'banduo_session';
const DAY = 24 * 60 * 60 * 1000;
const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');
const passwordHash = (password, salt = crypto.randomBytes(16).toString('hex')) => {
  const hash = crypto.pbkdf2Sync(password, salt, 210000, 32, 'sha256').toString('hex');
  return { salt, hash };
};
const passwordOk = (password, salt, expected) => crypto.timingSafeEqual(
  Buffer.from(passwordHash(password, salt).hash, 'hex'), Buffer.from(expected, 'hex'));
const json = (res, status, payload, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(payload));
};
const cookieValue = (req, name) => {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
};
const monthNow = () => new Date().toISOString().slice(0, 7);
const yuan = (cents) => Number((cents / 100).toFixed(2));
function validLocalDateTime(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) return false;
  const y = Number(match[1]), mo = Number(match[2]), d = Number(match[3]);
  const h = Number(match[4]), mi = Number(match[5]), sec = Number(match[6] || 0);
  if (y < 2000 || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || sec > 59) return false;
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, sec));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

function initialize(db, options) {
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','agent')), password_salt TEXT NOT NULL,
      password_hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      csrf_token TEXT NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES users(id), code TEXT NOT NULL UNIQUE,
      amount_cents INTEGER NOT NULL CHECK(amount_cents>=0), accepted_at TEXT NOT NULL,
      month TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('valid','pending','cancelled','refunded')),
      channel TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS orders_month_agent_time ON orders(month,agent_id,accepted_at);
    CREATE TABLE IF NOT EXISTS monthly_rates (
      month TEXT NOT NULL, agent_id TEXT NOT NULL REFERENCES users(id), rate_bp INTEGER NOT NULL CHECK(rate_bp BETWEEN 0 AND 10000),
      version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL,
      PRIMARY KEY(month,agent_id)
    );
    CREATE TABLE IF NOT EXISTS settlements (
      month TEXT PRIMARY KEY, settled_at TEXT NOT NULL, snapshot_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT NOT NULL, actor_name TEXT NOT NULL,
      action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
    );`);
  const admin = db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get();
  if (!admin) {
    const username = options.adminUsername || process.env.ADMIN_USERNAME || 'admin';
    const displayName = options.adminName || process.env.ADMIN_NAME || '酒店管理员';
    const password = options.adminPassword || process.env.ADMIN_PASSWORD || crypto.randomBytes(15).toString('base64url');
    const { salt, hash } = passwordHash(password);
    const id = crypto.randomUUID();
    db.prepare('INSERT INTO users(id,username,display_name,role,password_salt,password_hash,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(id, username, displayName, 'admin', salt, hash, new Date().toISOString());
    if (!options.adminPassword && !process.env.ADMIN_PASSWORD) console.log(`首次管理员账号: ${username}\n首次管理员密码（请立即保存）: ${password}`);
  }
}

function createApplication(options = {}) {
  const dbPath = options.dbPath || process.env.DB_PATH || path.join(ROOT, 'data', 'banduo.sqlite');
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  initialize(db, options);
  const loginFailures = new Map();
  const registrationAttempts = new Map();

  function audit(actor, action, detail = '') {
    db.prepare('INSERT INTO audit_log(actor_id,actor_name,action,detail,created_at) VALUES(?,?,?,?,?)')
      .run(actor.id, actor.display_name, action, detail, new Date().toISOString());
  }
  function currentUser(req) {
    const token = cookieValue(req, COOKIE_NAME);
    if (!token) return null;
    const row = db.prepare(`SELECT s.token_hash,s.csrf_token,u.id,u.username,u.display_name,u.role,u.active
      FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?`)
      .get(sha256(token), Date.now());
    return row?.active ? { ...row, token } : null;
  }
  function isSameOrigin(req) {
    const origin = req.headers.origin;
    return !origin || !req.headers.host || new URL(origin).host === req.headers.host;
  }
  function readBody(req) {
    return new Promise((resolve, reject) => {
      let raw = '';
      req.on('data', chunk => { raw += chunk; if (raw.length > 256_000) reject(Object.assign(new Error('请求体过大'), { status: 413 })); });
      req.on('end', () => {
        if (!raw) return resolve({});
        try { resolve(JSON.parse(raw)); } catch { reject(Object.assign(new Error('JSON 格式错误'), { status: 400 })); }
      });
      req.on('error', reject);
    });
  }
  function cents(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > 100000000) throw Object.assign(new Error('房价金额无效'), { status: 400 });
    return Math.round(n * 100);
  }
  function ratesFor(month) {
    return db.prepare(`SELECT u.id AS agent_id,u.display_name,u.username,r.rate_bp,r.version,r.updated_at,r.updated_by
      FROM users u LEFT JOIN monthly_rates r ON r.agent_id=u.id AND r.month=?
      WHERE u.role='agent' AND u.active=1 ORDER BY u.display_name`).all(month);
  }
  function dashboard(month, selectedAgent, includeAdminData = false) {
    const agents = db.prepare("SELECT id,username,display_name,active FROM users WHERE role='agent' AND active=1 ORDER BY display_name").all();
    const summaries = agents.map(agent => {
      const detail = computeMonth(db, month, agent.id);
      const revenue = detail.reduce((sum, o) => sum + o.amount_cents, 0);
      const commission = detail.reduce((sum, o) => sum + o.commission_cents, 0);
      return { ...agent, order_count: detail.length, revenue_cents: revenue, commission_cents: commission,
        rate_bp: db.prepare('SELECT rate_bp FROM monthly_rates WHERE month=? AND agent_id=?').get(month, agent.id)?.rate_bp ?? null };
    });
    const agentId = selectedAgent || null;
    const details = computeMonth(db, month, agentId).map(o => ({ ...o, amount: yuan(o.amount_cents), commission: yuan(o.commission_cents), rate_percent: o.rate_bp / 100 }));
    const allOrders = db.prepare(`SELECT o.*,u.display_name AS agent_name FROM orders o JOIN users u ON u.id=o.agent_id
      WHERE o.month=? ${agentId ? 'AND o.agent_id=?' : ''} ORDER BY o.accepted_at DESC`)
      .all(...(agentId ? [month, agentId] : [month]));
    const ranking = new Map(details.map(o => [o.id, o]));
    const withStatus = allOrders.map(o => {
      const d = ranking.get(o.id);
      return { ...o, amount: yuan(o.amount_cents), sequence: d?.sequence ?? null,
        commission_type: d?.commission_type ?? null, commission: d ? yuan(d.commission_cents) : null,
        rate_percent: d ? d.rate_percent : null };
    });
    const eligible = summaries.filter(a => !agentId || a.id === agentId);
    const totals = eligible.reduce((sum, a) => ({ orders: sum.orders + a.order_count,
      revenue_cents: sum.revenue_cents + a.revenue_cents, commission_cents: sum.commission_cents + a.commission_cents }),
    { orders: 0, revenue_cents: 0, commission_cents: 0 });
    const pending = db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE month=? AND status='pending' ${agentId ? 'AND agent_id=?' : ''}`)
      .get(...(agentId ? [month, agentId] : [month])).n;
    const settled = db.prepare('SELECT settled_at,snapshot_json FROM settlements WHERE month=?').get(month);
    const snapshot = settled ? JSON.parse(settled.snapshot_json) : [];
    const audit = includeAdminData ? db.prepare('SELECT actor_name,action,detail,created_at FROM audit_log ORDER BY id DESC LIMIT 10').all() : [];
    return { month, totals: { ...totals, revenue: yuan(totals.revenue_cents), commission: yuan(totals.commission_cents), pending },
      agents: agentId ? agents.filter(a => a.id === agentId) : agents, summaries: eligible, orders: withStatus,
      rates: includeAdminData ? ratesFor(month) : [],
      settled: settled ? { settled_at: settled.settled_at, snapshot: includeAdminData ? snapshot : snapshot.filter(s => s.agent_id === agentId) } : null, audit };
  }
  async function handler(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const method = req.method;
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
    if (url.pathname.startsWith('/api/') && method !== 'GET' && !isSameOrigin(req)) return json(res, 403, { error: '来源校验失败' });
    try {
      if (url.pathname === '/api/health' && method === 'GET') return json(res, 200, { ok: true });
      if (url.pathname === '/api/register' && method === 'POST') {
        const key = req.socket.remoteAddress || 'unknown';
        const windowStart = Date.now() - 60 * 60 * 1000;
        const recent = (registrationAttempts.get(key) || []).filter(at => at > windowStart);
        if (recent.length >= 5) return json(res, 429, { error: '注册次数过多，请稍后再试或联系管理员' });
        recent.push(Date.now());
        registrationAttempts.set(key, recent);
        const body = await readBody(req), username = String(body.username || '').trim();
        const name = String(body.name || '').trim(), password = String(body.password || '');
        if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username) || !name || name.length > 60 || password.length < 12 || password.length > 200) {
          return json(res, 400, { error: '账号需 3–32 位英文/数字；姓名必填；密码需 12–200 位' });
        }
        const { salt, hash } = passwordHash(password), id = crypto.randomUUID();
        db.prepare('INSERT INTO users(id,username,display_name,role,password_salt,password_hash,active,created_at) VALUES(?,?,?,?,?,?,0,?)')
          .run(id, username, name, 'agent', salt, hash, new Date().toISOString());
        return json(res, 201, { ok: true, message: '注册申请已提交，请等待酒店管理员审核后登录' });
      }
      if (url.pathname === '/api/login' && method === 'POST') {
        const body = await readBody(req);
        const key = req.socket.remoteAddress || 'unknown';
        const fail = loginFailures.get(key) || { count: 0, until: 0 };
        if (fail.until > Date.now()) return json(res, 429, { error: '登录尝试过多，请稍后再试' });
        const user = db.prepare('SELECT * FROM users WHERE username=? AND active=1').get(String(body.username || '').trim());
        if (!user || !passwordOk(String(body.password || ''), user.password_salt, user.password_hash)) {
          fail.count++;
          if (fail.count >= 8) { fail.count = 0; fail.until = Date.now() + 5 * 60 * 1000; }
          loginFailures.set(key, fail);
          return json(res, 401, { error: '账号或密码不正确' });
        }
        loginFailures.delete(key);
        const token = crypto.randomBytes(32).toString('base64url');
        const csrf = crypto.randomBytes(24).toString('base64url');
        db.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES(?,?,?,?)')
          .run(sha256(token), user.id, csrf, Date.now() + 7 * DAY);
        const secure = process.env.COOKIE_SECURE === 'true' ? '; Secure' : '';
        return json(res, 200, { user: { id: user.id, username: user.username, name: user.display_name, role: user.role }, csrf },
          { 'Set-Cookie': `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${7 * 24 * 60 * 60}${secure}` });
      }
      const actor = currentUser(req);
      if (url.pathname.startsWith('/api/') && url.pathname !== '/api/login' && !actor) return json(res, 401, { error: '请先登录' });
      if (actor && method !== 'GET' && url.pathname.startsWith('/api/') && url.pathname !== '/api/login') {
        const csrf = req.headers['x-csrf-token'];
        if (!csrf || csrf !== actor.csrf_token) return json(res, 403, { error: '安全令牌无效，请刷新页面后重试' });
      }
      if (url.pathname === '/api/session' && method === 'GET') return json(res, 200,
        { user: { id: actor.id, username: actor.username, name: actor.display_name, role: actor.role }, csrf: actor.csrf_token });
      if (url.pathname === '/api/logout' && method === 'POST') {
        db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha256(actor.token));
        return json(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0` });
      }
      if (url.pathname === '/api/dashboard' && method === 'GET') {
        const month = url.searchParams.get('month') || monthNow();
        if (!validMonth(month)) return json(res, 400, { error: '月份格式应为 YYYY-MM' });
        const agentId = actor.role === 'agent' ? actor.id : (url.searchParams.get('agentId') || null);
        if (agentId && actor.role === 'admin' && !db.prepare("SELECT id FROM users WHERE id=? AND role='agent'").get(agentId)) return json(res, 404, { error: '代理人不存在' });
        return json(res, 200, dashboard(month, agentId, actor.role === 'admin'));
      }
      if (url.pathname === '/api/rates' && method === 'GET') {
        if (actor.role !== 'admin') return json(res, 403, { error: '仅管理员可管理提点规则' });
        const month = url.searchParams.get('month') || monthNow();
        if (!validMonth(month)) return json(res, 400, { error: '月份格式应为 YYYY-MM' });
        return json(res, 200, { month, settled: !!db.prepare('SELECT month FROM settlements WHERE month=?').get(month), rates: ratesFor(month) });
      }
      if (url.pathname === '/api/rates' && method === 'PUT') {
        if (actor.role !== 'admin') return json(res, 403, { error: '仅管理员可管理提点规则' });
        const body = await readBody(req), month = String(body.month || ''), value = Number(body.percentage);
        if (!validMonth(month) || !Number.isFinite(value) || value < 0 || value > 100) return json(res, 400, { error: '月份或提点比例无效' });
        if (db.prepare('SELECT month FROM settlements WHERE month=?').get(month)) return json(res, 409, { error: '该月份已结算，提点规则已冻结' });
        const targets = body.scope === 'all'
          ? db.prepare("SELECT id,display_name FROM users WHERE role='agent' AND active=1").all()
          : db.prepare("SELECT id,display_name FROM users WHERE id=? AND role='agent' AND active=1").all(body.agentId);
        if (!targets.length) return json(res, 400, { error: '请先选择有效代理人' });
        const rateBp = Math.round(value * 100), now = new Date().toISOString();
        const upsert = db.prepare(`INSERT INTO monthly_rates(month,agent_id,rate_bp,version,updated_at,updated_by) VALUES(?,?,?,1,?,?)
          ON CONFLICT(month,agent_id) DO UPDATE SET rate_bp=excluded.rate_bp,version=monthly_rates.version+1,updated_at=excluded.updated_at,updated_by=excluded.updated_by`);
        db.exec('BEGIN IMMEDIATE');
        try {
          for (const target of targets) {
            const previous = db.prepare('SELECT rate_bp FROM monthly_rates WHERE month=? AND agent_id=?').get(month, target.id)?.rate_bp;
            upsert.run(month, target.id, rateBp, now, actor.id);
            audit(actor, `调整 ${month} ${target.display_name} 提点比例`, `${previous == null ? '未设置' : `${previous / 100}%`} → ${value}%；订单按新规则重新核算`);
          }
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
        return json(res, 200, { ok: true, month, updated: targets.length, rates: ratesFor(month) });
      }
      if (url.pathname === '/api/orders' && method === 'POST') {
        const body = await readBody(req);
        const agentId = actor.role === 'agent' ? actor.id : String(body.agentId || '');
        if (!db.prepare("SELECT id FROM users WHERE id=? AND role='agent' AND active=1").get(agentId)) return json(res, 400, { error: '代理人无效' });
        const code = String(body.code || '').trim(), acceptedAt = String(body.acceptedAt || ''), amountCents = cents(body.amount);
        if (!code || code.length > 80 || !validLocalDateTime(acceptedAt)) return json(res, 400, { error: '请填写有效的订单编号和接入时间' });
        const status = actor.role === 'agent' ? 'pending' : normalizeStatus(body.status || 'valid');
        const id = crypto.randomUUID(), month = acceptedAt.slice(0, 7), now = new Date().toISOString();
        if (db.prepare('SELECT month FROM settlements WHERE month=?').get(month)) return json(res, 409, { error: '该月份已结算，不能新增订单' });
        db.prepare('INSERT INTO orders(id,agent_id,code,amount_cents,accepted_at,month,status,channel,note,created_by,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
          .run(id, agentId, code, amountCents, acceptedAt, month, status, String(body.channel || '').slice(0, 100), String(body.note || '').slice(0, 500), actor.id, now);
        audit(actor, `录入订单 ${code}`, `${agentId} · ¥${yuan(amountCents).toFixed(2)} · ${month}`);
        return json(res, 201, { ok: true, id });
      }
      const orderMatch = url.pathname.match(/^\/api\/orders\/([\w-]+)$/);
      if (orderMatch && method === 'PUT') {
        const existing = db.prepare('SELECT * FROM orders WHERE id=?').get(orderMatch[1]);
        if (!existing) return json(res, 404, { error: '订单不存在' });
        if (actor.role === 'agent' && (existing.agent_id !== actor.id || existing.status !== 'pending')) return json(res, 403, { error: '代理人只能修改本人待审核订单' });
        const body = await readBody(req);
        const agentId = actor.role === 'agent' ? actor.id : String(body.agentId || existing.agent_id);
        if (!db.prepare("SELECT id FROM users WHERE id=? AND role='agent' AND active=1").get(agentId)) return json(res, 400, { error: '代理人无效' });
        const code = String(body.code ?? existing.code).trim(), acceptedAt = String(body.acceptedAt ?? existing.accepted_at), amountCents = cents(body.amount ?? yuan(existing.amount_cents));
        if (!code || code.length > 80 || !validLocalDateTime(acceptedAt)) return json(res, 400, { error: '订单编号或接入时间无效' });
        const status = actor.role === 'agent' ? 'pending' : normalizeStatus(body.status ?? existing.status);
        const month = acceptedAt.slice(0, 7), now = new Date().toISOString();
        if (db.prepare('SELECT month FROM settlements WHERE month=? OR month=?').get(existing.month, month)) return json(res, 409, { error: '订单所属月份已结算，不能修改订单' });
        db.prepare('UPDATE orders SET agent_id=?,code=?,amount_cents=?,accepted_at=?,month=?,status=?,channel=?,note=?,updated_at=? WHERE id=?')
          .run(agentId, code, amountCents, acceptedAt, month, status, String(body.channel ?? existing.channel).slice(0, 100), String(body.note ?? existing.note).slice(0, 500), now, existing.id);
        audit(actor, `修改订单 ${code}`, `代理人/时间/房价/状态更新；有效订单顺序与绩效自动重算`);
        return json(res, 200, { ok: true });
      }
      if (url.pathname === '/api/agents' && method === 'GET') {
        if (actor.role !== 'admin') return json(res, 403, { error: '仅管理员可查看代理人账户' });
        return json(res, 200, { agents: db.prepare("SELECT id,username,display_name,active,created_at FROM users WHERE role='agent' ORDER BY display_name").all() });
      }
      const agentMatch = url.pathname.match(/^\/api\/agents\/([\w-]+)$/);
      if (agentMatch && method === 'PUT') {
        if (actor.role !== 'admin') return json(res, 403, { error: '仅管理员可审核代理人注册' });
        const target = db.prepare("SELECT id,username,display_name,active FROM users WHERE id=? AND role='agent'").get(agentMatch[1]);
        if (!target) return json(res, 404, { error: '代理人不存在' });
        const body = await readBody(req);
        if (body.active !== true && body.active !== false) return json(res, 400, { error: '账号状态无效' });
        db.prepare('UPDATE users SET active=? WHERE id=?').run(body.active ? 1 : 0, target.id);
        audit(actor, `${body.active ? '通过' : '停用'}代理人账号 ${target.display_name}`, `登录名 ${target.username}`);
        return json(res, 200, { ok: true, active: body.active });
      }
      if (url.pathname === '/api/agents' && method === 'POST') {
        if (actor.role !== 'admin') return json(res, 403, { error: '仅管理员可创建代理人账户' });
        const body = await readBody(req), username = String(body.username || '').trim(), name = String(body.name || '').trim(), password = String(body.password || '');
        if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username) || !name || name.length > 60 || password.length < 12) return json(res, 400, { error: '账号需 3–32 位英文/数字；姓名必填；初始密码至少 12 位' });
        const { salt, hash } = passwordHash(password), id = crypto.randomUUID();
        db.prepare('INSERT INTO users(id,username,display_name,role,password_salt,password_hash,created_at) VALUES(?,?,?,?,?,?,?)')
          .run(id, username, name, 'agent', salt, hash, new Date().toISOString());
        audit(actor, `创建代理人账户 ${name}`, `登录名 ${username}`);
        return json(res, 201, { ok: true, id });
      }
      if (url.pathname === '/api/settlements' && method === 'POST') {
        if (actor.role !== 'admin') return json(res, 403, { error: '仅管理员可确认结算' });
        const body = await readBody(req), month = String(body.month || '');
        if (!validMonth(month)) return json(res, 400, { error: '月份格式无效' });
        if (db.prepare('SELECT month FROM settlements WHERE month=?').get(month)) return json(res, 409, { error: '该月份已结算' });
        const agents = db.prepare("SELECT id,display_name FROM users WHERE role='agent' AND active=1 ORDER BY display_name").all();
        if (agents.some(a => !db.prepare('SELECT rate_bp FROM monthly_rates WHERE month=? AND agent_id=?').get(month, a.id))) return json(res, 409, { error: '请先设置所有代理人的本月提点比例' });
        const details = computeMonth(db, month), snapshots = agents.map(a => {
          const own = details.filter(o => o.agent_id === a.id), rate = db.prepare('SELECT rate_bp FROM monthly_rates WHERE month=? AND agent_id=?').get(month, a.id).rate_bp;
          return { agent_id: a.id, agent: a.display_name, rate_percent: rate / 100, order_count: own.length,
            revenue_cents: own.reduce((sum, o) => sum + o.amount_cents, 0), commission_cents: own.reduce((sum, o) => sum + o.commission_cents, 0) };
        });
        const settledAt = new Date().toISOString();
        db.prepare('INSERT INTO settlements(month,settled_at,snapshot_json) VALUES(?,?,?)').run(month, settledAt, JSON.stringify(snapshots));
        audit(actor, `确认 ${month} 月度结算`, `结算快照共 ${yuan(snapshots.reduce((s,a)=>s+a.commission_cents,0)).toFixed(2)} 元；比例已冻结`);
        return json(res, 201, { ok: true, month, settledAt, snapshots });
      }
      return json(res, 404, { error: '接口不存在' });
    } catch (error) {
      const status = error.status || (String(error.message).includes('UNIQUE constraint failed') ? 409 : 500);
      if (status === 500) console.error(error);
      return json(res, status, { error: status === 500 ? '服务器内部错误' : error.message });
    }
  }

  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
    if (!pathname.startsWith('/api/')) {
      const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
      const file = path.resolve(ROOT, 'public', relative);
      if (!file.startsWith(path.resolve(ROOT, 'public') + path.sep)) return json(res, 404, { error: '未找到' });
      fs.readFile(file, (err, content) => {
        if (err) return json(res, 404, { error: '未找到' });
        const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png' };
        res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' });
        res.end(content);
      });
      return;
    }
    handler(req, res);
  });
  return { server, db, close: () => { server.close(); db.close(); } };
}

if (require.main === module) {
  const app = createApplication();
  const port = Number(process.env.PORT || 3000);
  app.server.listen(port, process.env.HOST || '127.0.0.1', () => console.log(`瓣朵酒店绩效系统已启动: http://${process.env.HOST || '127.0.0.1'}:${port}`));
}
module.exports = { createApplication };

