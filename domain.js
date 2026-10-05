'use strict';

function monthFor(acceptedAt) { return String(acceptedAt).slice(0, 7); }
function validMonth(month) { return /^\d{4}-(0[1-9]|1[0-2])$/.test(month || ''); }
function normalizeStatus(status) {
  if (!['valid', 'pending', 'cancelled', 'refunded'].includes(status)) throw new Error('订单状态无效');
  return status;
}
function computeMonth(db, month, agentId = null) {
  if (!validMonth(month)) throw new Error('月份格式应为 YYYY-MM');
  const query = agentId
    ? db.prepare('SELECT * FROM orders WHERE month=? AND agent_id=? AND status=\'valid\' ORDER BY accepted_at, id')
    : db.prepare('SELECT * FROM orders WHERE month=? AND status=\'valid\' ORDER BY agent_id, accepted_at, id');
  const orders = agentId ? query.all(month, agentId) : query.all(month);
  const byAgent = new Map();
  for (const order of orders) {
    const list = byAgent.get(order.agent_id) || [];
    list.push(order);
    byAgent.set(order.agent_id, list);
  }
  const result = [];
  for (const [aid, list] of byAgent) {
    const rate = db.prepare('SELECT rate_bp FROM monthly_rates WHERE month=? AND agent_id=?').get(month, aid)?.rate_bp ?? 0;
    list.forEach((order, index) => {
      const fixed = index < 5;
      const commissionCents = fixed ? 5000 : Math.round(order.amount_cents * rate / 10000);
      result.push({ ...order, sequence: index + 1, commission_type: fixed ? '固定奖励' : '房价提成',
        rate_bp: rate, commission_cents: commissionCents });
    });
  }
  return result.sort((a, b) => a.accepted_at.localeCompare(b.accepted_at) || a.agent_id.localeCompare(b.agent_id));
}
function summarize(db, month, agentId = null) {
  const detailed = computeMonth(db, month, agentId);
  const grouped = new Map();
  for (const order of detailed) {
    const row = grouped.get(order.agent_id) || { agent_id: order.agent_id, order_count: 0, revenue_cents: 0, commission_cents: 0 };
    row.order_count++;
    row.revenue_cents += order.amount_cents;
    row.commission_cents += order.commission_cents;
    grouped.set(order.agent_id, row);
  }
  return { details: detailed, summaries: [...grouped.values()] };
}
module.exports = { monthFor, validMonth, normalizeStatus, computeMonth, summarize };
