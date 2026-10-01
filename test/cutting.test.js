'use strict';
const { test } = require('node:test');
const assert = require('assert');
const C = require('../src/cutting');

const H = (mm) => C.mmToH(mm);

// 极简发布快照：2 根内部公共边（50mm、30mm）+ 四根外框（100×2、60×2）
function snapshot() {
  return {
    width: 100, height: 60,
    leadList: {
      internal: [
        { no: 1, points: [[0, 0], [50, 0]], length: 50 },
        { no: 2, points: [[0, 0], [30, 0]], length: 30 },
      ],
      internalCount: 2,
      frameBars: [
        { name: '上框', from: [0, 0], to: [100, 0], length: 100 },
        { name: '下框', from: [0, 60], to: [100, 60], length: 100 },
        { name: '左框', from: [0, 0], to: [0, 60], length: 60 },
        { name: '右框', from: [100, 0], to: [100, 60], length: 60 },
      ],
    },
  };
}

test('长度解析：正数/负数/小数位/损耗可为零', () => {
  assert.strictEqual(C.parseLengthH(12.34, { name: 'x' }).value, 1234);
  assert.strictEqual(C.parseLengthH(12.345, { name: 'x' }).error.includes('0.01'), true);
  assert.ok(C.parseLengthH(0, { name: 'x' }).error, '定尺必须为正');
  assert.ok(C.parseLengthH(-1, { name: 'x' }).error, '负定尺拒绝');
  assert.strictEqual(C.parseLengthH(0, { name: '损耗', allowZero: true }).value, 0);
  assert.ok(C.parseLengthH(-0.01, { name: '损耗', allowZero: true }).error, '负损耗拒绝');
  assert.ok(C.parseLengthH('abc', { name: 'x' }).error);
  assert.ok(C.parseLengthH(NaN, { name: 'x' }).error);
});

test('件数/根数解析', () => {
  assert.strictEqual(C.parseCount(3, { name: '件数' }).value, 3);
  assert.ok(C.parseCount(0, { name: '件数' }).error, '件数必须为正');
  assert.ok(C.parseCount(-1, { name: '库存', allowZero: true }).error, '库存不得为负');
  assert.strictEqual(C.parseCount(0, { name: '库存', allowZero: true }).value, 0);
  assert.ok(C.parseCount(1.5, { name: '件数' }).error);
});

test('切段来源：仅内部公共边+四根外框，逐件不可拼接', () => {
  const segs = C.segmentsFromSnapshot(snapshot(), 2);
  assert.strictEqual(segs.length, 6 * 2); // 每件 6 根
  assert.deepStrictEqual(segs.map((s) => s.copyNo), [1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2]);
  assert.deepStrictEqual(segs.slice(0, 6).map((s) => s.ref),
    [1, 2, '上框', '下框', '左框', '右框']);
  assert.strictEqual(segs[0].lengthH, H(50));
});

test('排产：长度降序、同长按清单顺序，first-fit 放置', () => {
  const segs = C.segmentsFromSnapshot(snapshot(), 1);
  // 原材 120mm、每刀 2mm：段占 = 102,102,62,62,52,32
  const r = C.planCutting(segs, H(120), H(2));
  assert.ok(r.ok);
  // bin1: 102 (剩18, 62/52/32 均放不下)；bin2: 102；bin3: 62+52=114(再放32→146不行)；bin4: 62+32=94
  assert.strictEqual(r.needed, 4);
  assert.deepStrictEqual(r.bins[0].cuts.map((c) => c.lengthH), [H(100)]);
  assert.deepStrictEqual(r.bins[2].cuts.map((c) => c.lengthH), [H(60), H(50)]);
  assert.deepStrictEqual(r.bins[3].cuts.map((c) => c.lengthH), [H(60), H(30)]);
  // 降序
  for (const b of r.bins) {
    const ls = b.cuts.map((c) => c.lengthH);
    for (let i = 1; i < ls.length; i++) assert.ok(ls[i - 1] >= ls[i]);
  }
  // 同长按清单顺序：两根 100 的外框应保持 上框→下框
  assert.strictEqual(r.bins[0].cuts[0].ref, '上框');
  assert.strictEqual(r.bins[1].cuts[0].ref, '下框');
  // 余料
  assert.strictEqual(r.bins[0].remainderH, H(120) - H(102));
  assert.strictEqual(r.bins[2].remainderH, H(120) - (H(62) + H(52)));
  // 每段占用 = 成品 + 一刀损耗
  for (const b of r.bins) for (const c of b.cuts) assert.strictEqual(c.consumeH, c.lengthH + H(2));
});

test('排产：零损耗可紧贴填满', () => {
  const segs = C.segmentsFromSnapshot(snapshot(), 1);
  const r = C.planCutting(segs, H(100), 0);
  // 100+? → 100 两根各自满；60+? 可放 30=90；60+50 不行 → bin: [100],[100],[60,30],[60],[50]
  assert.strictEqual(r.needed, 5);
  assert.strictEqual(r.bins[0].remainderH, 0);
});

test('排产：单段放不下（含损耗）拒绝', () => {
  const segs = C.segmentsFromSnapshot(snapshot(), 1);
  const r = C.planCutting(segs, H(101), H(2)); // 100+2 > 101
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'segment_too_long');
  assert.strictEqual(r.segment.lengthH, H(100));
  // 恰好放得下：100+2 = 102
  assert.strictEqual(C.planCutting(segs, H(102), H(2)).ok, true);
});

test('多件：同长度切段按清单条目（上框两件、再下框两件）', () => {
  const segs = C.segmentsFromSnapshot(snapshot(), 2);
  const r = C.planCutting(segs, H(500), H(2));
  assert.strictEqual(r.needed, 2);
  const longOnes = r.bins[0].cuts.filter((c) => c.lengthH === H(100));
  assert.deepStrictEqual(longOnes.map((c) => [c.ref, c.copyNo]),
    [['上框', 1], ['上框', 2], ['下框', 1], ['下框', 2]]);
});

test('合计：成品总长与损耗总长', () => {
  const segs = C.segmentsFromSnapshot(snapshot(), 3);
  const r = C.planCutting(segs, H(500), H(2));
  // 每件成品 50+30+100+100+60+60=400；3 件 =1200；18 段 ×2 = 36
  assert.strictEqual(r.totalProductH, H(1200));
  assert.strictEqual(r.totalKerfH, H(36));
  assert.strictEqual(r.totalUsedH, H(1236));
});
