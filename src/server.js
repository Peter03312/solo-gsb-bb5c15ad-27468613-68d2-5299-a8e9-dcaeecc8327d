'use strict';

const path = require('path');
const express = require('express');
const db = require('./db');
const geo = require('./geometry');
const cut = require('./cutting');

const PORT = parseInt(process.env.PORT || '3000', 10);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'studio.db');

db.init(DB_PATH);

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------- 工具 ----------

function fail(res, code, error, extra = {}) {
  return res.status(code).json({ ok: false, error, ...extra });
}

function loadDesignOr404(req, res) {
  const design = db.getDesign(Number(req.params.designId));
  if (!design) {
    fail(res, 404, '图纸不存在');
    return null;
  }
  return design;
}

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const DEFAULT_COLORS = ['#4C9AFF', '#FFAB00', '#36B37E', '#FF5630', '#6554C0', '#00B8D9', '#FF8B00', '#8FAB1E'];

function parsePolygon(body) {
  const poly = body.polygon;
  if (!Array.isArray(poly)) return { error: 'polygon 必须是 [[x,y],...] 数组' };
  const pts = [];
  for (const p of poly) {
    if (!Array.isArray(p) || p.length !== 2 ||
      !Number.isInteger(p[0]) || !Number.isInteger(p[1])) {
      return { error: '每个顶点必须是两个整数毫米坐标' };
    }
    pts.push([p[0], p[1]]);
  }
  return { polygon: pts };
}

// 汇总草稿：片、面积、覆盖状态、缺口、铅条清单
function draftSummary(design) {
  const rows = db.listPieces(design.id);
  const pieces = rows.map((r) => ({
    id: r.id,
    pieceNo: r.pieceNo,
    color: r.color,
    polygon: r.polygon,
    area: geo.round2(geo.polygonArea(r.polygon)),
  }));
  const analysis = geo.analyzePlan(
    { width: design.width_mm, height: design.height_mm },
    rows.map((r) => ({ id: r.id, polygon: r.polygon })),
  );
  return {
    id: design.id,
    name: design.name,
    width: design.width_mm,
    height: design.height_mm,
    createdAt: design.created_at,
    updatedAt: design.updated_at,
    pieces,
    coverage: {
      covered: analysis.covered,
      gaps: analysis.gaps,
      overlapping: analysis.overlapping,
      totalPieceArea: analysis.totalPieceArea,
      frameArea: design.width_mm * design.height_mm,
    },
    leadList: buildLeadList(analysis),
  };
}

// 铅条下料清单：内部公共边合并极大共线段；外框四根另列
function buildLeadList(analysis) {
  const { width, height, total } = analysis.frameLead;
  return {
    internal: analysis.leadRuns.runs.map((r, i) => ({
      no: i + 1,
      points: r.points,
      length: r.length,
    })),
    internalCount: analysis.leadRuns.count,
    internalTotal: analysis.leadRuns.total,
    frameBars: [
      { name: '上框', from: [0, 0], to: [width, 0], length: geo.round2(width) },
      { name: '下框', from: [0, height], to: [width, height], length: geo.round2(width) },
      { name: '左框', from: [0, 0], to: [0, height], length: geo.round2(height) },
      { name: '右框', from: [width, 0], to: [width, height], length: geo.round2(height) },
    ],
    frameTotal: geo.round2(total),
    grandTotal: geo.round2(analysis.leadRuns.total + total),
  };
}

// 对一次新增/编辑做全部几何校验；通过返回 null，否则返回 422 响应体
function validateEdit(design, candidatePolygon, ignorePieceId) {
  const frame = { width: design.width_mm, height: design.height_mm };

  const self = geo.validatePolygon(candidatePolygon);
  if (!self.ok) {
    return { error: self.reason, category: 'invalid', at: self.at || null };
  }
  const others = db.listPieces(design.id)
    .filter((r) => r.id !== ignorePieceId)
    .map((r) => ({ id: r.id, polygon: r.polygon }));
  // checkAgainstPieces 内部统一做越界（矩形窗框为凸集，顶点在内则边在内）与重叠校验
  const rel = geo.checkAgainstPieces(candidatePolygon, others, frame);
  if (!rel.ok) {
    return {
      error: rel.reason,
      category: 'overlap',
      at: rel.at ? rel.at.slice() : null,
      pieceId: rel.pieceId || null,
    };
  }
  return null;
}

// ---------- 图纸 ----------

app.get('/api/designs', (req, res) => {
  res.json({ ok: true, designs: db.listDesigns() });
});

app.post('/api/designs', (req, res) => {
  const { name } = req.body || {};
  const width = Number(req.body?.width);
  const height = Number(req.body?.height);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    return fail(res, 400, '窗框宽高必须是正整数毫米');
  }
  if (width > 100000 || height > 100000) {
    return fail(res, 400, '窗框尺寸过大（上限 100000 毫米）');
  }
  const design = db.createDesign({
    name: typeof name === 'string' && name.trim() ? name.trim().slice(0, 80) : '未命名图纸',
    width, height,
  });
  res.status(201).json({ ok: true, design });
});

app.get('/api/designs/:designId', (req, res) => {
  const design = loadDesignOr404(req, res);
  if (!design) return;
  res.json({ ok: true, draft: draftSummary(design) });
});

// ---------- 草稿拼片 ----------

app.post('/api/designs/:designId/pieces', (req, res) => {
  const design = loadDesignOr404(req, res);
  if (!design) return;
  const parsed = parsePolygon(req.body || {});
  if (parsed.error) return fail(res, 400, parsed.error);
  let color = (req.body.color || '').trim();
  if (!color) color = DEFAULT_COLORS[db.listPieces(design.id).length % DEFAULT_COLORS.length];
  if (!COLOR_RE.test(color)) return fail(res, 400, '颜色必须是 #RRGGBB 形式');

  const problem = validateEdit(design, parsed.polygon, null);
  if (problem) return res.status(422).json({ ok: false, ...problem });

  const piece = db.addPiece(design.id, { color, polygon: parsed.polygon });
  res.status(201).json({ ok: true, piece: withArea(piece), draft: draftSummary(db.getDesign(design.id)) });
});

app.put('/api/designs/:designId/pieces/:pieceId', (req, res) => {
  const design = loadDesignOr404(req, res);
  if (!design) return;
  const pieceId = Number(req.params.pieceId);
  const existing = db.getPiece(design.id, pieceId);
  if (!existing) return fail(res, 404, '拼片不存在');

  const parsed = parsePolygon(req.body || {});
  if (parsed.error) return fail(res, 400, parsed.error);
  const color = (req.body.color || '').trim();
  if (!COLOR_RE.test(color)) return fail(res, 400, '颜色必须是 #RRGGBB 形式');

  const problem = validateEdit(design, parsed.polygon, pieceId);
  if (problem) return res.status(422).json({ ok: false, ...problem });

  const updated = db.updatePiece(design.id, pieceId, { color, polygon: parsed.polygon });
  res.json({ ok: true, piece: withArea(updated), draft: draftSummary(db.getDesign(design.id)) });
});

app.delete('/api/designs/:designId/pieces/:pieceId', (req, res) => {
  const design = loadDesignOr404(req, res);
  if (!design) return;
  const removed = db.deletePiece(design.id, Number(req.params.pieceId));
  if (!removed) return fail(res, 404, '拼片不存在');
  res.json({ ok: true, draft: draftSummary(db.getDesign(design.id)) });
});

function withArea(piece) {
  return { ...piece, area: geo.round2(geo.polygonArea(piece.polygon)) };
}

// ---------- 发布 ----------

app.get('/api/designs/:designId/publications', (req, res) => {
  const design = loadDesignOr404(req, res);
  if (!design) return;
  res.json({ ok: true, publications: db.listPublications(design.id) });
});

app.post('/api/designs/:designId/publish', (req, res) => {
  const design = loadDesignOr404(req, res);
  if (!design) return;
  const summary = draftSummary(design);
  if (summary.pieces.length === 0) {
    return fail(res, 422, '草稿为空，不能发布');
  }
  if (!summary.coverage.covered) {
    return res.status(422).json({
      ok: false,
      error: '草稿未完整覆盖窗框或存在重叠，不能发布',
      category: 'not_covered',
      gaps: summary.coverage.gaps,
      overlapping: summary.coverage.overlapping,
    });
  }
  const snapshot = {
    name: summary.name,
    width: summary.width,
    height: summary.height,
    pieces: summary.pieces,
    leadList: summary.leadList,
    frameArea: summary.coverage.frameArea,
  };
  const pub = db.publishVersion(design.id, snapshot);
  res.status(201).json({ ok: true, publication: pub });
});

app.get('/api/designs/:designId/publications/:version', (req, res) => {
  const design = loadDesignOr404(req, res);
  if (!design) return;
  const pub = db.getPublicationByVersion(design.id, Number(req.params.version));
  if (!pub) return fail(res, 404, '发布版不存在');
  res.json({ ok: true, publication: pub });
});

// ---------- 铅条原材 ----------

// 对外 DTO：库存长度换算为毫米（保留 2 位）
function materialDTO(m) {
  return {
    id: m.id,
    length: cut.hToMm(m.lengthH),
    stockCount: m.stockCount,
    reservedCount: m.reservedCount,
    availableCount: m.availableCount,
    createdAt: m.createdAt,
  };
}

app.get('/api/lead-materials', (req, res) => {
  res.json({ ok: true, materials: db.listMaterials().map(materialDTO) });
});

// 登记原材定尺与初始库存根数
app.post('/api/lead-materials', (req, res) => {
  const len = cut.parseLengthH(Number(req.body?.length), { name: '原材定尺' });
  if (len.error) return fail(res, 400, len.error);
  const stock = cut.parseCount(Number(req.body?.stockCount ?? req.body?.stock), { name: '库存根数', allowZero: true });
  if (stock.error) return fail(res, 400, stock.error);
  if (db.getMaterialByLength(len.value)) {
    return fail(res, 409, '该定尺原材已登记，请使用补货接口增加根数');
  }
  const m = db.createMaterial(len.value, stock.value);
  res.status(201).json({ ok: true, material: materialDTO(m) });
});

// 补货：仅允许增加，绝不允许为负
app.post('/api/lead-materials/:id/restock', (req, res) => {
  const id = Number(req.params.id);
  const m0 = db.getMaterial(id);
  if (!m0) return fail(res, 404, '原材规格不存在');
  const add = cut.parseCount(Number(req.body?.addCount ?? req.body?.count), { name: '补货根数' });
  if (add.error) return fail(res, 400, add.error);
  const m = db.restockMaterial(id, add.value);
  res.json({ ok: true, material: materialDTO(m) });
});

// ---------- 铅条生产计划 ----------

// 单根原材上的切段 → 对外 JSON（长度/损耗/余料换算为毫米）
function binDTO(bin) {
  return {
    no: bin.no,
    cuts: bin.cuts.map((c, i) => ({
      order: i + 1,
      label: c.label,
      copyNo: c.copyNo,
      kind: c.kind,
      ref: c.ref,
      from: c.from,
      to: c.to,
      length: cut.hToMm(c.lengthH),
      kerf: cut.hToMm(c.consumeH - c.lengthH),
      occupied: cut.hToMm(c.consumeH),
    })),
    used: cut.hToMm(bin.usedH),
    remainder: cut.hToMm(bin.remainderH),
  };
}

function planDTO(p) {
  const material = db.getMaterial(p.materialId);
  return {
    id: p.id,
    status: p.status,
    designId: p.designId,
    publicationId: p.publicationId,
    version: p.version,
    copies: p.copies,
    materialId: p.materialId,
    materialLength: cut.hToMm(p.materialLengthH),
    kerf: cut.hToMm(p.kerfH),
    neededCount: p.neededCount,
    segmentCount: p.segments.length,
    totalProduct: cut.hToMm(p.cutting.totalProductH),
    totalKerf: cut.hToMm(p.cutting.totalKerfH),
    totalUsed: cut.hToMm(p.cutting.totalUsedH),
    bins: p.cutting.bins.map(binDTO),
    // 当前库存视角（确认后可用数会随之减少）
    stockCount: material ? material.stockCount : null,
    reservedCount: material ? material.reservedCount : null,
    availableCount: material ? material.availableCount : null,
    // 缺口只对草稿有意义：已确认计划已预留成功；取消计划不再参与
    shortage: material && p.status === 'draft'
      ? Math.max(0, p.neededCount - material.availableCount) : 0,
    createdAt: p.createdAt,
    confirmedAt: p.confirmedAt,
    cancelledAt: p.cancelledAt,
  };
}

// 从请求解析 { publication, material, copies, kerfH } 或返回错误响应（已发送）
function resolvePlanInput(req, res) {
  const publicationId = Number(req.body?.publicationId);
  const materialId = Number(req.body?.materialId);
  const copies = cut.parseCount(Number(req.body?.copies), { name: '件数' });
  if (copies.error) { fail(res, 400, copies.error); return null; }
  const kerf = cut.parseLengthH(Number(req.body?.kerf ?? 0), { name: '每刀损耗', allowZero: true });
  if (kerf.error) { fail(res, 400, kerf.error); return null; }

  const pubRow = db.getDb()
    .prepare('SELECT * FROM publications WHERE id = ?').get(publicationId);
  if (!pubRow) { fail(res, 404, '发布版不存在，只能依据已发布版本制作计划'); return null; }
  const publication = {
    id: pubRow.id, designId: pubRow.design_id, version: pubRow.version,
    snapshot: JSON.parse(pubRow.snapshot),
  };
  const material = db.getMaterial(materialId);
  if (!material) { fail(res, 404, '原材规格不存在，请先登记原材定尺'); return null; }

  return { publication, material, copies: copies.value, kerfH: kerf.value };
}

// 依据发布快照计算排产结果（不写库）
function computeCutting(publication, material, copies, kerfH) {
  const segments = cut.segmentsFromSnapshot(publication.snapshot, copies);
  const result = cut.planCutting(segments, material.lengthH, kerfH);
  if (!result.ok) return result;
  const available = material.availableCount;
  return {
    ...result,
    segments,
    feasible: result.needed <= available,
    availableCount: available,
    shortage: Math.max(0, result.needed - available),
  };
}

function cuttingPayload(c, material, publication, copies, kerfH) {
  return {
    designId: publication.designId,
    publicationId: publication.id,
    version: publication.version,
    copies,
    materialId: material.id,
    materialLength: cut.hToMm(material.lengthH),
    kerf: cut.hToMm(kerfH),
    segmentCount: c.segments.length,
    neededCount: c.needed,
    stockCount: material.stockCount,
    reservedCount: material.reservedCount,
    availableCount: material.availableCount,
    feasible: c.feasible,
    shortage: c.shortage,
    totalProduct: cut.hToMm(c.totalProductH),
    totalKerf: cut.hToMm(c.totalKerfH),
    totalUsed: cut.hToMm(c.totalUsedH),
    bins: c.bins.map(binDTO),
  };
}

// 预览：选发布版本/件数/原材规格/每刀损耗，返回逐根切段、余料、需用根数；不占库存
app.post('/api/lead-plans/preview', (req, res) => {
  const input = resolvePlanInput(req, res);
  if (!input) return;
  const { publication, material, copies, kerfH } = input;
  const c = computeCutting(publication, material, copies, kerfH);
  if (!c.ok) {
    return res.status(422).json({
      ok: false, error: `切段「${c.segment.label} 第${c.segment.copyNo}件」长 ${cut.hToMm(c.segment.lengthH)} mm，加上每刀损耗后超过原材定尺，不可拼接、无法切段`,
      category: 'segment_too_long',
      segment: { label: c.segment.label, copyNo: c.segment.copyNo, length: cut.hToMm(c.segment.lengthH) },
      materialLength: cut.hToMm(material.lengthH), kerf: cut.hToMm(kerfH),
    });
  }
  res.json({ ok: true, preview: cuttingPayload(c, material, publication, copies, kerfH) });
});

// 制作计划（草稿，不占库存；缺口可见但允许先保存）
app.post('/api/lead-plans', (req, res) => {
  const input = resolvePlanInput(req, res);
  if (!input) return;
  const { publication, material, copies, kerfH } = input;
  const c = computeCutting(publication, material, copies, kerfH);
  if (!c.ok) {
    return res.status(422).json({
      ok: false, error: `切段「${c.segment.label} 第${c.segment.copyNo}件」长 ${cut.hToMm(c.segment.lengthH)} mm，超过原材定尺，不可拼接`,
      category: 'segment_too_long',
    });
  }
  const plan = db.createPlan({
    publicationId: publication.id, designId: publication.designId, version: publication.version,
    copies, materialId: material.id, materialLengthH: material.lengthH, kerfH,
    neededCount: c.needed,
    cutting: {
      bins: c.bins,
      totalProductH: c.totalProductH, totalKerfH: c.totalKerfH, totalUsedH: c.totalUsedH,
    },
    segments: c.segments,
  });
  res.status(201).json({ ok: true, plan: planDTO(plan) });
});

app.get('/api/lead-plans', (req, res) => {
  res.json({ ok: true, plans: db.listPlans().map(planDTO) });
});

app.get('/api/lead-plans/:id', (req, res) => {
  const plan = db.getPlan(Number(req.params.id));
  if (!plan) return fail(res, 404, '计划不存在');
  res.json({ ok: true, plan: planDTO(plan) });
});

// 确认：原子预留库存（需用根数超过可用数时返回 409 + 缺口，不能确认）
app.post('/api/lead-plans/:id/confirm', (req, res) => {
  const r = db.confirmPlanTx(Number(req.params.id));
  if (!r.ok) {
    return fail(res, r.status, r.reason,
      r.shortage != null ? { shortage: r.shortage, available: r.available, needed: r.needed } : {});
  }
  res.json({ ok: true, plan: planDTO(r.plan) });
});

// 取消：仅草稿可取消；重复确认/取消均不会重复改变库存
app.post('/api/lead-plans/:id/cancel', (req, res) => {
  const r = db.cancelPlanTx(Number(req.params.id));
  if (!r.ok) return fail(res, r.status, r.reason);
  res.json({ ok: true, plan: planDTO(r.plan) });
});

// 前端单页
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// 统一错误处理
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError) return fail(res, 400, '请求体不是合法 JSON');
  console.error(err);
  fail(res, 500, '服务器内部错误');
});

module.exports = app;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`彩绘玻璃拼片台已启动: http://localhost:${PORT}`);
    console.log(`数据库文件: ${DB_PATH}`);
  });
}
