'use strict';

// 铅条排产核心：长度一律以 0.01 毫米为最小单位、用整数（百分之一毫米）运算，
// 彻底规避浮点误差；仅在对外输出时换算回毫米。

const MM = 100; // 1 mm = 100 个单位
const MAX_LENGTH_H = 1_000_000 * MM; // 长度上限 1,000,000 mm
const MAX_COUNT = 1_000_000;

// ---------- 输入解析 ----------

// 长度（毫米，小数位不超过 2）→ 百分之一毫米整数。
// opts.allowZero=true 时允许 0（用于每刀损耗），但仍不得为负。
function parseLengthH(value, { name = '长度', allowZero = false } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { error: `${name}必须是数字` };
  }
  if (allowZero ? value < 0 : value <= 0) {
    return { error: allowZero ? `${name}不得为负` : `${name}必须为正数` };
  }
  if (value > MAX_LENGTH_H / MM) return { error: `${name}超出允许范围` };
  const h = Math.round(value * MM);
  // 拒绝超过两位小数的输入（正常浮点误差在 1e-9 以内会被吸收）
  if (Math.abs(h / MM - value) > 1e-9) {
    return { error: `${name}精度不得超过 0.01 毫米` };
  }
  if (allowZero ? h < 0 : h <= 0) {
    return { error: allowZero ? `${name}不得为负` : `${name}必须为正数` };
  }
  return { value: h };
}

// 整数根数 / 件数
function parseCount(value, { name = '数量', allowZero = false } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    return { error: `${name}必须是整数` };
  }
  if (allowZero ? value < 0 : value <= 0) {
    return { error: allowZero ? `${name}不得为负` : `${name}必须为正数` };
  }
  if (value > MAX_COUNT) return { error: `${name}超出允许范围` };
  return { value };
}

// 快照中的毫米长度（已四舍五入到 0.01）→ 百分之一毫米
function mmToH(v) {
  return Math.round(v * MM);
}
const hToMm = (h) => h / MM;

// ---------- 切段来源 ----------

// 从发布版快照取铅条清单：只取内部公共边（按清单编号）与四根外框（按 上/下/左/右）。
// copies 为制作件数；每件都是不可拼接的独立切段，copyNo 从 1 起。
// 返回的每段带 seq（清单顺序）、copyNo（件序号）。
function segmentsFromSnapshot(snapshot, copies) {
  const leadList = snapshot.leadList;
  if (!leadList || !Array.isArray(leadList.internal) || !Array.isArray(leadList.frameBars)) {
    throw new Error('发布快照缺少铅条清单');
  }
  const template = [];
  leadList.internal.forEach((r) => {
    template.push({
      seq: template.length,
      kind: 'internal',
      ref: r.no,
      label: `内部公共边 #${r.no}`,
      from: r.points[0],
      to: r.points[r.points.length - 1],
      lengthH: mmToH(r.length),
    });
  });
  leadList.frameBars.forEach((b) => {
    template.push({
      seq: template.length,
      kind: 'frame',
      ref: b.name,
      label: `外框·${b.name}`,
      from: b.from,
      to: b.to,
      lengthH: mmToH(b.length),
    });
  });
  const out = [];
  for (let copyNo = 1; copyNo <= copies; copyNo++) {
    for (const s of template) {
      // order：逐件展开后的清单总顺序（同长度切段的排序依据）
      out.push({ ...s, copyNo, order: out.length });
    }
  }
  return out;
}

// ---------- 排产（First-Fit Decreasing） ----------

// 入参：segments=[{seq,copyNo,lengthH,...}]，stockLengthH/kerfH 均为百分之一毫米整数。
// 每段占用 = 成品长度 + 一刀损耗；段不可拼接。
// 排序：长度降序；同长按清单顺序（seq），同一根清单条目跨件时按件号（copyNo）。
// 放置：依次放入第一根能容纳它的原材，放不下才开新原材。
// 返回 { ok:true, bins, needed, total* } 或
//      { ok:false, code:'segment_too_long', segment }（单段连全新原材都放不下）。
function planCutting(segments, stockLengthH, kerfH) {
  for (const s of segments) {
    if (s.lengthH + kerfH > stockLengthH) {
      return { ok: false, code: 'segment_too_long', segment: s };
    }
  }

  // 排序：长度降序；同长按清单顺序——先按铅条清单中的条目序号（内部公共边
  // 编号在前、随后上/下/左/右四根外框），同一条目再按件号。
  const ordered = segments.slice().sort((a, b) =>
    (b.lengthH - a.lengthH) || (a.seq - b.seq) || (a.copyNo - b.copyNo));

  const bins = [];
  let totalProductH = 0;
  let totalKerfH = 0;
  for (const s of ordered) {
    const consumeH = s.lengthH + kerfH;
    let bin = bins.find((b) => stockLengthH - b.usedH >= consumeH);
    if (!bin) {
      bin = { cuts: [], usedH: 0 };
      bins.push(bin);
    }
    bin.cuts.push({ ...s, consumeH });
    bin.usedH += consumeH;
    totalProductH += s.lengthH;
    totalKerfH += kerfH;
  }
  bins.forEach((b, i) => {
    b.no = i + 1;
    b.remainderH = stockLengthH - b.usedH;
  });

  return {
    ok: true,
    bins,
    needed: bins.length,
    totalProductH,
    totalKerfH,
    totalUsedH: totalProductH + totalKerfH,
  };
}

module.exports = {
  MM,
  parseLengthH,
  parseCount,
  mmToH,
  hToMm,
  segmentsFromSnapshot,
  planCutting,
};
