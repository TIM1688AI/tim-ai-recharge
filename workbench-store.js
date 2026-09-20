'use strict';
const { randomUUID } = require('node:crypto');
const { fail } = require('./workbench-security');
function createStore(pool) {
  const query = (sql, args = []) => pool.query(sql, args);
  async function tx(fn) {
    const c = await pool.connect();
    try { await c.query('BEGIN'); const result = await fn(c); await c.query('COMMIT'); return result; }
    catch (e) { await c.query('ROLLBACK'); if (e.code === '23505' && e.constraint === 'wb_orders_active_target') fail(409, '此账号的同类充值仍在处理，请查询原订单'); throw e; } finally { c.release(); }
  }
  const audit = (c, action, target = '') => c.query('INSERT INTO wb_audit(action,target) VALUES($1,$2)', [action, target]);
  async function existing(key, fingerprint, c = pool) {
    const row = (await c.query('SELECT * FROM wb_orders WHERE request_key=$1', [key])).rows[0];
    if (row && row.fingerprint !== fingerprint) fail(409, '同一请求编号不能用于不同账号或产品');
    return row;
  }
  return {
    query, tx, audit, existing,
    async importCard(data) {
      return tx(async c => {
        await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [data.digest]);
        if ((await c.query('SELECT 1 FROM wb_public_claims WHERE digest=$1', [data.digest])).rowCount) fail(409, '此卡已有提交记录，不能作为新库存入库');
        const r = await c.query('INSERT INTO wb_cards(id,channel,product,digest,secret,hint,state) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(digest) DO NOTHING RETURNING id', [randomUUID(), data.channel, data.product, data.digest, data.secret, data.hint, data.state]);
        if (!r.rowCount) fail(409, '卡密已入库（含原始格式或 TIM 别名）');
        await audit(c, 'import', r.rows[0].id); return r.rows[0].id;
      });
    },
    async reserve({ key, fingerprint, channel, product, identity, identityHash }) {
      return tx(async c => {
        await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['order:' + key]);
        const previous = await existing(key, fingerprint, c);
        if (previous) return { order: previous, fresh: false };
        if ((await c.query("SELECT 1 FROM wb_orders WHERE channel=$1 AND product=$2 AND identity_hash=$3 AND source='admin' AND state IN ('pending','processing','unknown')", [channel, product, identityHash])).rowCount) fail(409, '此账号的同类充值仍在处理，请查询原订单');
        const stock = (await c.query("SELECT * FROM wb_cards WHERE channel=$1 AND product=$2 AND state='available' ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1", [channel, product])).rows[0];
        if (!stock) fail(409, '该通道和产品暂无可用库存');
        await c.query("UPDATE wb_cards SET state='reserved',updated_at=now() WHERE id=$1", [stock.id]);
        const order = (await c.query("INSERT INTO wb_orders(id,request_key,fingerprint,card_id,channel,product,identity,identity_hash,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'pending') RETURNING *", [randomUUID(), key, fingerprint, stock.id, channel, product, identity, identityHash])).rows[0];
        await audit(c, 'recharge', order.id); return { order, stock, fresh: true };
      });
    },
    async publicClaim(digest, identity, identityHash) {
      return tx(async c => {
        await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [digest]);
        const stock = (await c.query('SELECT * FROM wb_cards WHERE digest=$1 FOR UPDATE', [digest])).rows[0];
        if (stock && stock.state !== 'issued') fail(409, '该卡密由工作台管理或已有提交，请联系站长查询');
        const claim = await c.query('INSERT INTO wb_public_claims(digest) VALUES($1) ON CONFLICT DO NOTHING RETURNING digest', [digest]);
        if (!claim.rowCount) fail(409, '此卡已有提交，请查询结果，勿重复充值');
        if (!stock) return null;
        await c.query("UPDATE wb_cards SET state='reserved',updated_at=now() WHERE id=$1", [stock.id]);
        const order = (await c.query("INSERT INTO wb_orders(id,request_key,fingerprint,card_id,channel,product,identity,identity_hash,state,source) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'pending','public') RETURNING *", [randomUUID(), 'public:' + digest, digest, stock.id, stock.channel, stock.product, identity, identityHash])).rows[0];
        await audit(c, 'public_recharge', order.id); return order;
      });
    },
    async updateOrder(id, result) {
      return tx(async c => {
        const o = (await c.query('SELECT * FROM wb_orders WHERE id=$1 FOR UPDATE', [id])).rows[0];
        if (!o || ['success', 'failed'].includes(o.state)) return o;
        if (result.completed_at && new Date(result.completed_at).getTime() < new Date(o.created_at).getTime() - 300000) result = { state: 'unknown', note: '供应商完成时间早于本次订单，请人工核对，不能确认本次成功' };
        if (o.task_id && result.task_id && o.task_id !== result.task_id) result = { state: 'unknown', note: '供应商返回的任务编号变化，请人工核对' };
        const updated = (await c.query("UPDATE wb_orders SET state=$2,task_id=CASE WHEN $3='' THEN task_id ELSE $3 END,note=$4,updated_at=now(),next_check=now()+interval '2 minutes',completed_at=CASE WHEN $2='success' THEN COALESCE($5::timestamptz,now()) ELSE completed_at END WHERE id=$1 RETURNING *", [id, result.state, result.task_id || '', result.note || '', result.completed_at || null])).rows[0];
        await c.query("UPDATE wb_cards SET state=$2,updated_at=now() WHERE id=$1", [o.card_id, result.state === 'success' ? 'used' : result.state === 'failed' ? 'quarantine' : 'reserved']);
        return updated;
      });
    },
    async issue({ key, channel, product, quantity }) {
      return tx(async c => {
        await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['issue:' + key]);
        const previous = (await c.query('SELECT * FROM wb_batches WHERE request_key=$1', [key])).rows[0];
        if (previous) {
          if (previous.channel !== channel || previous.product !== product || previous.quantity !== quantity) fail(409, '出库编号已用于其他请求');
          return previous;
        }
        const cards = (await c.query("SELECT id FROM wb_cards WHERE channel=$1 AND product=$2 AND state='available' ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT $3", [channel, product, quantity])).rows;
        if (cards.length !== quantity) fail(409, '可用库存不足，本次未出库');
        const batch = (await c.query('INSERT INTO wb_batches(id,request_key,channel,product,quantity) VALUES($1,$2,$3,$4,$5) RETURNING *', [randomUUID(), key, channel, product, quantity])).rows[0];
        for (const card of cards) { await c.query("UPDATE wb_cards SET state='issued',updated_at=now() WHERE id=$1", [card.id]); await c.query('INSERT INTO wb_issued(batch_id,card_id) VALUES($1,$2)', [batch.id, card.id]); }
        await audit(c, 'issue', batch.id); return batch;
      });
    },
    async takeDue() {
      return tx(async c => {
        const rows = (await c.query("SELECT id FROM wb_orders WHERE state IN ('pending','processing','unknown') AND next_check<=now() ORDER BY next_check FOR UPDATE SKIP LOCKED LIMIT 5")).rows;
        for (const row of rows) await c.query("UPDATE wb_orders SET next_check=now()+interval '5 minutes' WHERE id=$1", [row.id]);
        return rows;
      });
    },
  };
}
module.exports = { createStore };
