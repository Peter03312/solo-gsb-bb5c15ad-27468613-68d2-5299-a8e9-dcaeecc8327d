'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

let db;

function init(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    -- 一张图纸（窗框固定）；草稿内容在 pieces 表中就地编辑
    CREATE TABLE IF NOT EXISTS designs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL,
      width_mm    INTEGER NOT NULL CHECK (width_mm  > 0),
      height_mm   INTEGER NOT NULL CHECK (height_mm > 0),
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- 草稿拼片：编号在一张图纸内递增且永不复用
    CREATE TABLE IF NOT EXISTS pieces (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      design_id   INTEGER NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
      piece_no    INTEGER NOT NULL,
      color       TEXT    NOT NULL,
      polygon     TEXT    NOT NULL,           -- JSON [[x,y],...] 整数毫米
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE (design_id, piece_no)
    );

    -- 发布版：不可变快照，版本号在一张图纸内递增
    CREATE TABLE IF NOT EXISTS publications (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      design_id   INTEGER NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
      version     INTEGER NOT NULL,
      snapshot    TEXT    NOT NULL,           -- 完整快照 JSON
      published_at TEXT   NOT NULL DEFAULT (datetime('now')),
      UNIQUE (design_id, version)
    );

    -- 铅条原材：按定尺（长度，0.01mm 整数）登记库存根数；定尺全局唯一
    CREATE TABLE IF NOT EXISTS lead_materials (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      length_h     INTEGER NOT NULL UNIQUE CHECK (length_h > 0),  -- 定尺，百分之一毫米
      stock_count  INTEGER NOT NULL DEFAULT 0 CHECK (stock_count >= 0), -- 总库存根数
      created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- 铅条生产计划：创建即为 draft（不占库存），确认后绑定发布快照并原子预留
    CREATE TABLE IF NOT EXISTS lead_plans (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      status           TEXT NOT NULL DEFAULT 'draft'
                         CHECK (status IN ('draft','confirmed','cancelled')),
      publication_id   INTEGER NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
      design_id        INTEGER NOT NULL,
      version          INTEGER NOT NULL,
      copies           INTEGER NOT NULL CHECK (copies > 0),
      material_id      INTEGER NOT NULL REFERENCES lead_materials(id),
      material_length_h INTEGER NOT NULL CHECK (material_length_h > 0), -- 创建时快照
      kerf_h           INTEGER NOT NULL CHECK (kerf_h >= 0),             -- 每刀损耗，百分之一毫米
      needed_count     INTEGER NOT NULL CHECK (needed_count > 0),
      cutting          TEXT    NOT NULL,          -- 排产结果 JSON（切段/原材/余料）
      segments         TEXT    NOT NULL,          -- 切段来源快照 JSON
      created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
      confirmed_at     TEXT,
      cancelled_at     TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_pieces_design ON pieces(design_id);
    CREATE INDEX IF NOT EXISTS idx_pub_design    ON publications(design_id);
    CREATE INDEX IF NOT EXISTS idx_lead_plans_pub ON lead_plans(publication_id);
    CREATE INDEX IF NOT EXISTS idx_lead_plans_mat ON lead_plans(material_id);
  `);
  return db;
}

function getDb() {
  if (!db) throw new Error('数据库未初始化');
  return db;
}

// ---------- designs ----------

function createDesign({ name, width, height }) {
  const info = getDb()
    .prepare('INSERT INTO designs (name, width_mm, height_mm) VALUES (?, ?, ?)')
    .run(name, width, height);
  return getDesign(info.lastInsertRowid);
}

function getDesign(id) {
  return getDb().prepare('SELECT * FROM designs WHERE id = ?').get(id);
}

function listDesigns() {
  return getDb().prepare(`
    SELECT d.*,
      (SELECT COUNT(*) FROM pieces p WHERE p.design_id = d.id) AS piece_count,
      (SELECT MAX(version) FROM publications pu WHERE pu.design_id = d.id) AS latest_version
    FROM designs d ORDER BY d.id
  `).all();
}

// ---------- pieces ----------

function rowToPiece(row) {
  return {
    id: row.id,
    pieceNo: row.piece_no,
    color: row.color,
    polygon: JSON.parse(row.polygon),
    createdAt: row.created_at,
  };
}

function listPieces(designId) {
  return getDb()
    .prepare('SELECT * FROM pieces WHERE design_id = ? ORDER BY piece_no')
    .all(designId)
    .map(rowToPiece);
}

function getPiece(designId, pieceId) {
  const row = getDb()
    .prepare('SELECT * FROM pieces WHERE id = ? AND design_id = ?')
    .get(pieceId, designId);
  return row ? rowToPiece(row) : null;
}

function nextPieceNo(designId) {
  const row = getDb()
    .prepare('SELECT COALESCE(MAX(piece_no), 0) + 1 AS n FROM pieces WHERE design_id = ?')
    .get(designId);
  return row.n;
}

function addPiece(designId, { color, polygon }) {
  const pieceNo = nextPieceNo(designId);
  const info = getDb()
    .prepare('INSERT INTO pieces (design_id, piece_no, color, polygon) VALUES (?, ?, ?, ?)')
    .run(designId, pieceNo, color, JSON.stringify(polygon));
  touchDesign(designId);
  return getPiece(designId, info.lastInsertRowid);
}

function updatePiece(designId, pieceId, { color, polygon }) {
  const existing = getPiece(designId, pieceId);
  if (!existing) return null;
  getDb().prepare('UPDATE pieces SET color = ?, polygon = ? WHERE id = ? AND design_id = ?')
    .run(color, JSON.stringify(polygon), pieceId, designId);
  touchDesign(designId);
  return getPiece(designId, pieceId);
}

function deletePiece(designId, pieceId) {
  const info = getDb()
    .prepare('DELETE FROM pieces WHERE id = ? AND design_id = ?')
    .run(pieceId, designId);
  if (info.changes) touchDesign(designId);
  return info.changes > 0;
}

function replaceAllPieces(designId, pieces) {
  // 目前未使用；保留以便整单导入
  const tx = getDb().transaction((rows) => {
    getDb().prepare('DELETE FROM pieces WHERE design_id = ?').run(designId);
    for (const pc of rows) addPiece(designId, pc);
  });
  tx(pieces);
}

function touchDesign(designId) {
  getDb().prepare("UPDATE designs SET updated_at = datetime('now') WHERE id = ?").run(designId);
}

// ---------- publications ----------

function publishVersion(designId, snapshot) {
  const next = nextVersion(designId);
  const info = getDb()
    .prepare('INSERT INTO publications (design_id, version, snapshot) VALUES (?, ?, ?)')
    .run(designId, next, JSON.stringify(snapshot));
  return getPublication(designId, info.lastInsertRowid);
}

function nextVersion(designId) {
  const row = getDb()
    .prepare('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM publications WHERE design_id = ?')
    .get(designId);
  return row.v;
}

function getPublication(designId, pubId) {
  const row = getDb()
    .prepare('SELECT * FROM publications WHERE id = ? AND design_id = ?')
    .get(pubId, designId);
  return row ? {
    id: row.id,
    designId: row.design_id,
    version: row.version,
    publishedAt: row.published_at,
    snapshot: JSON.parse(row.snapshot),
  } : null;
}

function getPublicationByVersion(designId, version) {
  const row = getDb()
    .prepare('SELECT * FROM publications WHERE design_id = ? AND version = ?')
    .get(designId, version);
  return row ? {
    id: row.id,
    designId: row.design_id,
    version: row.version,
    publishedAt: row.published_at,
    snapshot: JSON.parse(row.snapshot),
  } : null;
}

function listPublications(designId) {
  return getDb()
    .prepare('SELECT id, version, published_at FROM publications WHERE design_id = ? ORDER BY version DESC')
    .all(designId)
    .map((r) => ({ id: r.id, version: r.version, publishedAt: r.published_at }));
}

// ---------- 铅条原材 ----------

function getMaterialByLength(lengthH) {
  const row = getDb().prepare('SELECT * FROM lead_materials WHERE length_h = ?').get(lengthH);
  return row ? materialRow(row) : null;
}

function getMaterial(id) {
  const row = getDb().prepare('SELECT * FROM lead_materials WHERE id = ?').get(id);
  return row ? materialRow(row) : null;
}

// 已确认计划对该原材的预留根数
function reservedCount(materialId) {
  const row = getDb()
    .prepare("SELECT COALESCE(SUM(needed_count), 0) AS n FROM lead_plans WHERE material_id = ? AND status = 'confirmed'")
    .get(materialId);
  return row.n;
}

function materialRow(row) {
  const reserved = getDb()
    .prepare("SELECT COALESCE(SUM(needed_count), 0) AS n FROM lead_plans WHERE material_id = ? AND status = 'confirmed'")
    .get(row.id).n;
  return {
    id: row.id,
    lengthH: row.length_h,
    stockCount: row.stock_count,
    reservedCount: reserved,
    availableCount: row.stock_count - reserved,
    createdAt: row.created_at,
  };
}

function listMaterials() {
  return getDb().prepare('SELECT * FROM lead_materials ORDER BY length_h DESC, id').all().map(materialRow);
}

function createMaterial(lengthH, stockCount) {
  const info = getDb()
    .prepare('INSERT INTO lead_materials (length_h, stock_count) VALUES (?, ?)')
    .run(lengthH, stockCount);
  return getMaterial(info.lastInsertRowid);
}

// 补货（仅允许增加）。行锁在 immediate 事务内完成。
function restockMaterial(id, addCount) {
  getDb()
    .prepare('UPDATE lead_materials SET stock_count = stock_count + ? WHERE id = ?')
    .run(addCount, id);
  return getMaterial(id);
}

// ---------- 铅条生产计划 ----------

function planRow(row) {
  return {
    id: row.id,
    status: row.status,
    publicationId: row.publication_id,
    designId: row.design_id,
    version: row.version,
    copies: row.copies,
    materialId: row.material_id,
    materialLengthH: row.material_length_h,
    kerfH: row.kerf_h,
    neededCount: row.needed_count,
    cutting: JSON.parse(row.cutting),
    segments: JSON.parse(row.segments),
    createdAt: row.created_at,
    confirmedAt: row.confirmed_at,
    cancelledAt: row.cancelled_at,
  };
}

function createPlan({ publicationId, designId, version, copies, materialId, materialLengthH, kerfH, neededCount, cutting, segments }) {
  const info = getDb()
    .prepare(`INSERT INTO lead_plans
      (status, publication_id, design_id, version, copies, material_id, material_length_h, kerf_h, needed_count, cutting, segments)
      VALUES ('draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(publicationId, designId, version, copies, materialId, materialLengthH, kerfH,
      neededCount, JSON.stringify(cutting), JSON.stringify(segments));
  return getPlan(info.lastInsertRowid);
}

function getPlan(id) {
  const row = getDb().prepare('SELECT * FROM lead_plans WHERE id = ?').get(id);
  return row ? planRow(row) : null;
}

function listPlans() {
  return getDb().prepare('SELECT * FROM lead_plans ORDER BY id DESC').all().map(planRow);
}

// 原子确认：仅当计划为 draft 且现有库存足够（含其它计划已预留）时成功。
// SQLite 单写入者 + immediate 事务保证多个并发确认不会超卖。
// 返回 { ok, reason?, plan? }
function confirmPlanTx(id) {
  const tx = getDb().transaction(() => {
    const row = getDb().prepare('SELECT * FROM lead_plans WHERE id = ?').get(id);
    if (!row) return { ok: false, status: 404, reason: '计划不存在' };
    if (row.status === 'confirmed') return { ok: false, status: 409, reason: '计划已确认，请勿重复确认' };
    if (row.status === 'cancelled') return { ok: false, status: 409, reason: '计划已取消，不能确认' };

    const mat = getDb().prepare('SELECT * FROM lead_materials WHERE id = ?').get(row.material_id);
    if (!mat) return { ok: false, status: 409, reason: '原材规格已不存在' };
    const reserved = getDb()
      .prepare("SELECT COALESCE(SUM(needed_count), 0) AS n FROM lead_plans WHERE material_id = ? AND status = 'confirmed'")
      .get(row.material_id).n;
    if (mat.stock_count - reserved < row.needed_count) {
      return {
        ok: false, status: 409, reason: '可用原材不足，无法确认',
        shortage: row.needed_count - (mat.stock_count - reserved),
        available: mat.stock_count - reserved, needed: row.needed_count,
      };
    }
    getDb()
      .prepare("UPDATE lead_plans SET status = 'confirmed', confirmed_at = datetime('now') WHERE id = ?")
      .run(id);
    return { ok: true };
  });
  const r = tx.immediate();
  if (!r.ok) return r;
  return { ok: true, plan: getPlan(id) };
}

// 取消：幂等安全——已取消返回 conflict；已确认仅改状态（预留随 status 失效，
// 物理库存根数永不被扣减），重复取消不会再次改变库存。
function cancelPlanTx(id) {
  const tx = getDb().transaction(() => {
    const row = getDb().prepare('SELECT * FROM lead_plans WHERE id = ?').get(id);
    if (!row) return { ok: false, status: 404, reason: '计划不存在' };
    if (row.status === 'cancelled') return { ok: false, status: 409, reason: '计划已取消，请勿重复操作' };
    if (row.status === 'confirmed') return { ok: false, status: 409, reason: '计划已确认，不能取消' };
    getDb()
      .prepare("UPDATE lead_plans SET status = 'cancelled', cancelled_at = datetime('now') WHERE id = ?")
      .run(id);
    return { ok: true };
  });
  const r = tx.immediate();
  if (!r.ok) return r;
  return { ok: true, plan: getPlan(id) };
}

module.exports = {
  init, getDb,
  createDesign, getDesign, listDesigns,
  listPieces, getPiece, addPiece, updatePiece, deletePiece, replaceAllPieces,
  publishVersion, getPublication, getPublicationByVersion, listPublications,
  createMaterial, getMaterial, getMaterialByLength, listMaterials, restockMaterial, reservedCount,
  createPlan, getPlan, listPlans, confirmPlanTx, cancelPlanTx,
};
