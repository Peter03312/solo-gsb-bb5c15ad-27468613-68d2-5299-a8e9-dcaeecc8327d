'use strict';
const { test, before, after, describe } = require('node:test');
const assert = require('assert');
const path = require('path');
const fs = require('fs');

const TMP = path.join(__dirname, '..', 'data');
process.env.DB_PATH = path.join(TMP, `test-${process.pid}-${Date.now()}.db`);
process.env.PORT = '0';

const app = require('../src/server');
const db = require('../src/db');

let server, base;
before(async () => {
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((r) => server.close(r));
  db.getDb().close();
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.rmSync(process.env.DB_PATH + ext); } catch (_) { /* ignore */ }
  }
});

async function api(method, urlPath, body, raw) {
  const resp = await fetch(base + urlPath, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await resp.json().catch(() => null);
  return { status: resp.status, data, ok: resp.ok && (!raw && data?.ok !== false) };
}

// 创建一张已发布图纸：窗框 100×60，两片平分；铅条清单 = 1 根内部公共边(60) + 外框 100×2、60×2
async function publishSimpleDesign(name) {
  const d = (await api('POST', '/api/designs', { name: name || '测试窗', width: 100, height: 60 })).data.design;
  await api('POST', `/api/designs/${d.id}/pieces`, { color: '#4c9aff', polygon: [[0, 0], [50, 0], [50, 60], [0, 60]] });
  await api('POST', `/api/designs/${d.id}/pieces`, { color: '#ffab00', polygon: [[50, 0], [100, 0], [100, 60], [50, 60]] });
  const pub = (await api('POST', `/api/designs/${d.id}/publish`)).data.publication;
  return { design: d, pub };
}

describe('HTTP API：原材登记与补货', () => {
  test('非法输入拒绝且不改库存', async () => {
    const badLengths = [0, -10, 12.345, 'x', NaN];
    for (const length of badLengths) {
      const r = await api('POST', '/api/lead-materials', { length, stockCount: 5 });
      assert.strictEqual(r.status, 400, `长度 ${length} 应拒绝`);
    }
    const badStock = await api('POST', '/api/lead-materials', { length: 2000, stockCount: -1 });
    assert.strictEqual(badStock.status, 400);
    const list = await api('GET', '/api/lead-materials');
    assert.deepStrictEqual(list.data.materials, []);
  });

  test('登记定尺与库存；重复定尺 409；补货只增不接受负数', async () => {
    const r = await api('POST', '/api/lead-materials', { length: 1800, stockCount: 3 });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.data.material.stockCount, 3);
    assert.strictEqual(r.data.material.availableCount, 3);
    const dup = await api('POST', '/api/lead-materials', { length: 1800, stockCount: 1 });
    assert.strictEqual(dup.status, 409);
    const bad = await api('POST', `/api/lead-materials/${r.data.material.id}/restock`, { addCount: -2 });
    assert.strictEqual(bad.status, 400);
    const zero = await api('POST', `/api/lead-materials/${r.data.material.id}/restock`, { addCount: 0 });
    assert.strictEqual(zero.status, 400);
    const ok = await api('POST', `/api/lead-materials/${r.data.material.id}/restock`, { addCount: 2 });
    assert.strictEqual(ok.data.material.stockCount, 5);
  });
});

describe('HTTP API：预览与制作计划', () => {
  let pub, matShort, matLong;

  before(async () => {
    ({ pub } = await publishSimpleDesign());
    matShort = (await api('POST', '/api/lead-materials', { length: 200, stockCount: 10 })).data.material;
    matLong = (await api('POST', '/api/lead-materials', { length: 1000, stockCount: 1 })).data.material;
  });

  test('计划参数非法（件数非正/损耗负/精度超 0.01）拒绝', async () => {
    for (const copies of [0, -1, 1.5]) {
      const r = await api('POST', '/api/lead-plans/preview', {
        publicationId: pub.id, materialId: matLong.id, copies, kerf: 2,
      });
      assert.strictEqual(r.status, 400, `件数 ${copies}`);
    }
    const r1 = await api('POST', '/api/lead-plans/preview', {
      publicationId: pub.id, materialId: matLong.id, copies: 1, kerf: -0.5,
    });
    assert.strictEqual(r1.status, 400);
    const r2 = await api('POST', '/api/lead-plans/preview', {
      publicationId: pub.id, materialId: matLong.id, copies: 1, kerf: 0.123,
    });
    assert.strictEqual(r2.status, 400);
  });

  test('只能选已发布版本；未知发布版/原材 404', async () => {
    const r = await api('POST', '/api/lead-plans/preview', { publicationId: 999999, materialId: matLong.id, copies: 1, kerf: 2 });
    assert.strictEqual(r.status, 404);
    const r2 = await api('POST', '/api/lead-plans/preview', { publicationId: pub.id, materialId: 999999, copies: 1, kerf: 2 });
    assert.strictEqual(r2.status, 404);
  });

  test('预览只取公共边+四根外框，逐件切段且不占库存', async () => {
    const r = await api('POST', '/api/lead-plans/preview', {
      publicationId: pub.id, materialId: matLong.id, copies: 2, kerf: 2,
    });
    assert.strictEqual(r.status, 200);
    const p = r.data.preview;
    assert.strictEqual(p.segmentCount, 5 * 2); // 1 公共边 + 4 外框，每件
    // 成品 = 2*(60+100+100+60+60)=760；损耗 = 10*2=20
    assert.strictEqual(p.totalProduct, 760);
    assert.strictEqual(p.totalKerf, 20);
    for (const bin of p.bins) {
      for (const c of bin.cuts) {
        assert.ok(['internal', 'frame'].includes(c.kind));
        assert.strictEqual(c.occupied, c.length + c.kerf);
      }
    }
    // 预览不占库存
    const m = (await api('GET', '/api/lead-materials')).data.materials.find((x) => x.id === matLong.id);
    assert.strictEqual(m.reservedCount, 0);
    assert.strictEqual(m.availableCount, 1);
  });

  test('单段放不下返回 422 且拒绝', async () => {
    // 200mm 定尺能放 100mm 外框（+2 损耗），无超长段；再登记 90mm 原材则 100mm 段放不下
    const tiny = (await api('POST', '/api/lead-materials', { length: 90, stockCount: 9 })).data.material;
    const r = await api('POST', '/api/lead-plans/preview', {
      publicationId: pub.id, materialId: tiny.id, copies: 1, kerf: 2,
    });
    assert.strictEqual(r.status, 422);
    assert.strictEqual(r.data.category, 'segment_too_long');
  });

  test('需用根数超过可用数：显示缺口、可存草稿但不能确认', async () => {
    // 200mm 原材、损耗 2mm：段占 102,102,62,62,62 → bins: [102],[102],[62+62+62=186] = 3 根；库存 10 充足
    const ok = await api('POST', '/api/lead-plans/preview', {
      publicationId: pub.id, materialId: matShort.id, copies: 1, kerf: 2,
    });
    assert.strictEqual(ok.data.preview.neededCount, 3);
    assert.strictEqual(ok.data.preview.feasible, true);

    // 限量原材：300mm 只有 1 根；所有段进同一根（102+102+62*3=390>300）→ 需 2 根，缺口 1
    const scarce = (await api('POST', '/api/lead-materials', { length: 300, stockCount: 1 })).data.material;
    const pv = await api('POST', '/api/lead-plans/preview', {
      publicationId: pub.id, materialId: scarce.id, copies: 1, kerf: 2,
    });
    assert.strictEqual(pv.data.preview.neededCount, 2);
    assert.strictEqual(pv.data.preview.shortage, 1);
    assert.strictEqual(pv.data.preview.feasible, false);

    const draft = await api('POST', '/api/lead-plans', {
      publicationId: pub.id, materialId: scarce.id, copies: 1, kerf: 2,
    });
    assert.strictEqual(draft.status, 201);
    assert.strictEqual(draft.data.plan.status, 'draft');
    const c = await api('POST', `/api/lead-plans/${draft.data.plan.id}/confirm`);
    assert.strictEqual(c.status, 409);
    assert.strictEqual(c.data.shortage, 1);
    // 确认失败不占库存
    const m = (await api('GET', '/api/lead-materials')).data.materials.find((x) => x.id === scarce.id);
    assert.strictEqual(m.reservedCount, 0);
  });
});

describe('HTTP API：确认/取消/快照/并发', () => {
  let design, pub, mat;
  before(async () => {
    ({ design, pub } = await publishSimpleDesign('快照窗'));
    mat = (await api('POST', '/api/lead-materials', { length: 203, stockCount: 20 })).data.material;
  });

  async function draftPlan(materialId = mat.id, copies = 1, kerf = 2) {
    return (await api('POST', '/api/lead-plans',
      { publicationId: pub.id, materialId, copies, kerf })).data.plan;
  }

  test('确认原子预留，可用数减少；重复确认 409 不重复扣减', async () => {
    const p = await draftPlan(); // 需 3 根
    const c1 = await api('POST', `/api/lead-plans/${p.id}/confirm`);
    assert.strictEqual(c1.status, 200);
    assert.strictEqual(c1.data.plan.status, 'confirmed');
    assert.strictEqual(c1.data.plan.availableCount, 17); // 20-3
    const c2 = await api('POST', `/api/lead-plans/${p.id}/confirm`);
    assert.strictEqual(c2.status, 409);
    const m = (await api('GET', '/api/lead-materials')).data.materials.find((x) => x.id === mat.id);
    assert.strictEqual(m.reservedCount, 3);
    assert.strictEqual(m.stockCount, 20); // 物理库存根数不变
  });

  test('草稿取消不改变库存；重复取消 409；已确认不可取消', async () => {
    const p = await draftPlan(); // 草稿，需 3 根
    const before = (await api('GET', '/api/lead-materials')).data.materials.find((x) => x.id === mat.id);
    const x1 = await api('POST', `/api/lead-plans/${p.id}/cancel`);
    assert.strictEqual(x1.status, 200);
    assert.strictEqual(x1.data.plan.status, 'cancelled');
    const after = (await api('GET', '/api/lead-materials')).data.materials.find((x) => x.id === mat.id);
    assert.deepStrictEqual([after.stockCount, after.reservedCount], [before.stockCount, before.reservedCount]);
    const x2 = await api('POST', `/api/lead-plans/${p.id}/cancel`);
    assert.strictEqual(x2.status, 409);
    const confirmed = await draftPlan();
    const cc = await api('POST', `/api/lead-plans/${confirmed.id}/confirm`);
    assert.strictEqual(cc.status, 200);
    const x3 = await api('POST', `/api/lead-plans/${confirmed.id}/cancel`);
    assert.strictEqual(x3.status, 409); // 已确认不能取消
  });

  test('并发确认不得超卖：库存 3 根、两计划各需 3 根，恰好一个成功', async () => {
    const tight = (await api('POST', '/api/lead-materials', { length: 202, stockCount: 3 })).data.material;
    const a = await draftPlan(tight.id);
    const b = await draftPlan(tight.id);
    const [ra, rb] = await Promise.all([
      api('POST', `/api/lead-plans/${a.id}/confirm`),
      api('POST', `/api/lead-plans/${b.id}/confirm`),
    ]);
    const oks = [ra, rb].filter((r) => r.status === 200);
    const fails = [ra, rb].filter((r) => r.status === 409);
    assert.strictEqual(oks.length, 1);
    assert.strictEqual(fails.length, 1);
    assert.strictEqual(fails[0].data.needed, 3);
    assert.strictEqual(fails[0].data.available, 0);
    assert.strictEqual(fails[0].data.shortage, 3);
    const m = (await api('GET', '/api/lead-materials')).data.materials.find((x) => x.id === tight.id);
    assert.strictEqual(m.reservedCount, 3);
    assert.strictEqual(m.availableCount, 0);
    assert.ok(m.reservedCount <= m.stockCount);
  });

  test('补货后缺口计划可确认', async () => {
    const tight = (await api('POST', '/api/lead-materials', { length: 201, stockCount: 2 })).data.material;
    const p = await draftPlan(tight.id); // 需 3 根，缺口 1
    assert.strictEqual((await api('POST', `/api/lead-plans/${p.id}/confirm`)).status, 409);
    await api('POST', `/api/lead-materials/${tight.id}/restock`, { addCount: 1 });
    const c = await api('POST', `/api/lead-plans/${p.id}/confirm`);
    assert.strictEqual(c.status, 200);
    assert.strictEqual(c.data.plan.availableCount, 0);
  });

  test('已确认计划绑定发布快照：草稿变化与新版本不改其用料', async () => {
    // 用本 describe 的图纸：v1 公共边在 x=50
    const v1 = (await api('GET', `/api/designs/${design.id}/publications/1`)).data.publication;
    assert.deepStrictEqual(v1.snapshot.leadList.internal[0].points[0], [50, 0]);

    // 改草稿（公共边移到 x=40）并发布 v2
    const pieces = (await api('GET', `/api/designs/${design.id}`)).data.draft.pieces;
    for (const pc of pieces) await api('DELETE', `/api/designs/${design.id}/pieces/${pc.id}`);
    await api('POST', `/api/designs/${design.id}/pieces`, { color: '#123456', polygon: [[0, 0], [40, 0], [40, 60], [0, 60]] });
    await api('POST', `/api/designs/${design.id}/pieces`, { color: '#654321', polygon: [[40, 0], [100, 0], [100, 60], [40, 60]] });
    const pv2 = await api('POST', `/api/designs/${design.id}/publish`);
    assert.strictEqual(pv2.status, 201);
    assert.strictEqual(pv2.data.publication.version, 2);
    assert.deepStrictEqual(pv2.data.publication.snapshot.leadList.internal[0].points[0], [40, 0]);

    // 此前已确认的 v1 计划：切段端点仍是 x=50，长度集合不变
    const plans = (await api('GET', '/api/lead-plans')).data.plans;
    const confirmedOld = plans.filter((p) => p.status === 'confirmed' &&
      p.publicationId === pub.id)[0];
    assert.ok(confirmedOld, '存在引用 v1 的已确认计划');
    const internalCuts = confirmedOld.bins
      .flatMap((b) => b.cuts)
      .filter((c) => c.kind === 'internal');
    assert.ok(internalCuts.every((c) => c.from[0] === 50 && c.to[0] === 50),
      '已确认计划切段仍绑定 v1 快照');
    const lengths = confirmedOld.bins.flatMap((b) => b.cuts.map((c) => c.length)).sort((x, y) => y - x);
    assert.deepStrictEqual(lengths, [100, 100, 60, 60, 60]);

    // v1 快照本身不变
    const again = (await api('GET', `/api/designs/${design.id}/publications/1`)).data.publication;
    assert.deepStrictEqual(again.snapshot.leadList.internal[0].points[0], [50, 0]);
  });
});
