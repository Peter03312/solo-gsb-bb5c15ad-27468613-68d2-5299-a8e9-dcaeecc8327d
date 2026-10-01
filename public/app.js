'use strict';

// ================= 状态 =================

const state = {
  draft: null,          // GET /designs/:id 返回
  drawing: null,        // { points:[[x,y]...] } 正在绘制的多边形
  editingId: null,      // 正在编辑（拖拽）的拼片 id
  error: null,          // { message, at, category, pieceId }
  showGaps: true,
};

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

// ================= API =================

async function api(method, url, body) {
  const resp = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await resp.json(); } catch (_) { /* ignore */ }
  if (!resp.ok || (data && data.ok === false)) {
    const err = new Error(data?.error || `请求失败 (${resp.status})`);
    err.data = data || {};
    err.status = resp.status;
    throw err;
  }
  return data;
}

// ================= 坐标变换 =================

function getTransform(draft, cv) {
  const pad = 40;
  const sx = (cv.width - pad * 2) / draft.width;
  const sy = (cv.height - pad * 2) / draft.height;
  const scale = Math.min(sx, sy);
  const ox = (cv.width - draft.width * scale) / 2;
  const oy = (cv.height - draft.height * scale) / 2;
  return {
    scale, ox, oy,
    toPx: (x, y) => [ox + x * scale, cv.height - (oy + y * scale)],
    toMm: (px, py) => [
      Math.round((px - ox) / scale),
      Math.round((cv.height - py - oy) / scale),
    ],
  };
}

// ================= 草稿渲染 =================

function renderDraft() {
  const d = state.draft;
  const banner = document.getElementById('errorBanner');
  if (!d) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    banner.hidden = true;
    return;
  }
  const t = getTransform(d, canvas);
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // 背景
  ctx.fillStyle = '#fbfaf7';
  ctx.fillRect(...t.toPx(0, d.height), d.width * t.scale, d.height * t.scale);

  // 缺口（红色斜纹，含“孤岛片”形成的带洞缺口）
  if (state.showGaps && !d.coverage.covered) {
    for (const gap of d.coverage.gaps) drawGap(gap, t);
    for (const ov of d.coverage.overlapping) drawOverlap(ov, t);
  }

  // 玻璃片
  for (const pc of d.pieces) drawPiece(pc, t);

  // 外框
  ctx.strokeStyle = '#222';
  ctx.lineWidth = 3;
  ctx.strokeRect(...t.toPx(0, d.height), d.width * t.scale, d.height * t.scale);

  // 正在绘制的多边形
  if (state.drawing) drawInProgress(t);

  // 错误位置标记
  if (state.error?.at) drawErrorMarker(state.error.at, t);

  renderPieceList();
  renderCoverage();
  renderLeadList();
}

function drawPiece(pc, t) {
  const pts = pc.polygon.map(([x, y]) => t.toPx(x, y));
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  ctx.fillStyle = pc.color;
  ctx.globalAlpha = 0.78;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 1.6;
  ctx.stroke();

  // 编号 + 面积，写在面积中心
  const [cx0, cy0] = centroid(pc.polygon);
  const [cx, cy] = t.toPx(cx0, cy0);
  const label = `#${pc.pieceNo} ${pc.area}mm²`;
  ctx.font = 'bold 13px sans-serif';
  const w = ctx.measureText(label).width;
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  ctx.fillRect(cx - w / 2 - 4, cy - 10, w + 8, 18);
  ctx.fillStyle = '#111';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, cx, cy);
}

function centroid(poly) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const f = poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
    a += f;
    cx += (poly[j][0] + poly[i][0]) * f;
    cy += (poly[j][1] + poly[i][1]) * f;
  }
  if (Math.abs(a) < 1e-9) {
    const sx = poly.reduce((s, p) => s + p[0], 0) / poly.length;
    const sy = poly.reduce((s, p) => s + p[1], 0) / poly.length;
    return [sx, sy];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

function tracePath(rings, t) {
  ctx.beginPath();
  for (const ring of rings) {
    const pts = ring.map(([x, y]) => t.toPx(x, y));
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
  }
}

function drawGap(gap, t) {
  const rings = [gap.outer || gap.polygon, ...(gap.holes || [])];
  tracePath(rings, t);
  ctx.fillStyle = 'rgba(210, 40, 30, 0.18)';
  ctx.fill('evenodd');
  ctx.save();
  ctx.clip('evenodd');
  ctx.strokeStyle = 'rgba(210, 40, 30, 0.55)';
  ctx.lineWidth = 2;
  for (let k = -600; k < 600; k += 10) {
    ctx.beginPath();
    ctx.moveTo(k, 0);
    ctx.lineTo(k + 600, 600);
    ctx.stroke();
  }
  ctx.restore();
  tracePath(rings, t);
  ctx.strokeStyle = '#c0281c';
  ctx.setLineDash([6, 4]);
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawOverlap(ov, t) {
  tracePath([ov.polygon], t);
  ctx.fillStyle = 'rgba(160, 0, 200, 0.2)';
  ctx.fill();
  ctx.strokeStyle = '#8b00b8';
  ctx.setLineDash([3, 3]);
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawInProgress(t) {
  const pts = state.drawing.points;
  if (!pts.length) return;
  const px = pts.map(([x, y]) => t.toPx(x, y));
  if (px.length >= 2) {
    ctx.beginPath();
    ctx.moveTo(px[0][0], px[0][1]);
    for (let i = 1; i < px.length; i++) ctx.lineTo(px[i][0], px[i][1]);
    ctx.strokeStyle = '#1565c0';
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  px.forEach(([x, y], i) => {
    ctx.beginPath();
    ctx.arc(x, y, i === 0 ? 5 : 4, 0, Math.PI * 2);
    ctx.fillStyle = i === 0 ? '#1565c0' : '#fff';
    ctx.fill();
    ctx.strokeStyle = '#1565c0';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#1565c0';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`${i + 1}(${pts[i][0]},${pts[i][1]})`, x + 7, y - 7);
  });
}

function drawErrorMarker(at, t) {
  const [x, y] = t.toPx(at[0], at[1]);
  ctx.beginPath();
  ctx.arc(x, y, 9, 0, Math.PI * 2);
  ctx.strokeStyle = '#d32f2f';
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x - 5, y - 5); ctx.lineTo(x + 5, y + 5);
  ctx.moveTo(x + 5, y - 5); ctx.lineTo(x - 5, y + 5);
  ctx.strokeStyle = '#d32f2f';
  ctx.lineWidth = 2.5;
  ctx.stroke();
}

// ================= 画布交互：绘制 =================

canvas.addEventListener('mousemove', (e) => {
  if (!state.draft) return;
  const t = getTransform(state.draft, canvas);
  const rect = canvas.getBoundingClientRect();
  const px = (e.clientX - rect.left) * (canvas.width / rect.width);
  const py = (e.clientY - rect.top) * (canvas.height / rect.height);
  const [x, y] = t.toMm(px, py);
  const inside = x >= 0 && y >= 0 && x <= state.draft.width && y <= state.draft.height;
  document.getElementById('cursorPos').textContent =
    `光标坐标: ${inside ? `${x}, ${y} mm` : '（窗框外）'}`;
});

canvas.addEventListener('click', (e) => {
  if (!state.draft || !state.drawing) return;
  const t = getTransform(state.draft, canvas);
  const rect = canvas.getBoundingClientRect();
  const px = (e.clientX - rect.left) * (canvas.width / rect.width);
  const py = (e.clientY - rect.top) * (canvas.height / rect.height);
  const [x, y] = t.toMm(px, py);
  if (x < 0 || y < 0 || x > state.draft.width || y > state.draft.height) {
    showError({ error: '顶点越出窗框', at: [x, y] });
    return;
  }
  // 吸附到已有顶点（8px 内），便于精确 T 接
  const snap = snapToVertex(x, y, t);
  state.drawing.points.push(snap || [x, y]);
  clearError();
  syncCoordsText();
  renderDraft();
});

canvas.addEventListener('dblclick', () => {
  if (state.drawing) finishDrawing();
});

function snapToVertex(x, y, t) {
  let best = null, bestD = 8;
  const consider = (vx, vy) => {
    const [px, py] = t.toPx(vx, vy);
    const [cx, cy] = t.toPx(x, y);
    const d = Math.hypot(px - cx, py - cy);
    if (d < bestD) { bestD = d; best = [vx, vy]; }
  };
  for (const pc of state.draft.pieces) pc.polygon.forEach((p) => consider(p[0], p[1]));
  [[0, 0], [state.draft.width, 0], [state.draft.width, state.draft.height], [0, state.draft.height]]
    .forEach((c) => consider(c[0], c[1]));
  state.drawing?.points.forEach((p) => consider(p[0], p[1]));
  return best;
}

function startDrawing() {
  state.drawing = { points: [] };
  document.getElementById('editHint').textContent = '在画布上依次点击顶点（自动吸附已有顶点），双击或点“闭合多边形”完成。';
  syncCoordsText();
  renderDraft();
}

function finishDrawing() {
  if (!state.drawing) return;
  const pts = state.drawing.points;
  if (pts.length < 3) {
    showError({ error: '多边形至少需要 3 个顶点' });
    return;
  }
  submitPiece(pts);
}

async function submitPiece(polygon) {
  const color = document.getElementById('pieceColor').value;
  const wasEditing = state.editingId !== null;
  try {
    const data = wasEditing
      ? await api('PUT', `/api/designs/${state.draft.id}/pieces/${state.editingId}`, { color, polygon })
      : await api('POST', `/api/designs/${state.draft.id}/pieces`, { color, polygon });
    state.draft = data.draft;
    state.drawing = null;
    state.editingId = null;
    document.getElementById('coordsInput').value = '';
    document.getElementById('editHint').textContent = '';
    showSuccess(wasEditing ? '拼片已更新' : '拼片已加入草稿');
    renderAllDraft();
  } catch (err) {
    showError(err.data?.error ? err.data : { error: err.message, at: err.data?.at });
  }
}

function cancelDrawing() {
  state.drawing = null;
  state.editingId = null;
  document.getElementById('coordsInput').value = '';
  document.getElementById('editHint').textContent = '';
  clearError();
  renderDraft();
}

function syncCoordsText() {
  if (!state.drawing) return;
  document.getElementById('coordsInput').value =
    state.drawing.points.map((p) => p.join(',')).join('\n');
}

// 手工坐标 → 开始绘制状态（供预览/提交）
function coordsFromTextarea() {
  const lines = document.getElementById('coordsInput').value
    .split(/[\n;]+/).map((s) => s.trim()).filter(Boolean);
  const pts = [];
  for (const line of lines) {
    const m = line.match(/^(-?\d+)\s*[,，\s]\s*(-?\d+)$/);
    if (!m) return { error: `无法解析坐标行: “${line}”` };
    pts.push([Number(m[1]), Number(m[2])]);
  }
  return { points: pts };
}

// ================= 侧栏列表与状态 =================

function renderPieceList() {
  const d = state.draft;
  document.getElementById('pieceCount').textContent = d.pieces.length;
  const ul = document.getElementById('pieceList');
  ul.innerHTML = '';
  for (const pc of d.pieces) {
    const li = document.createElement('li');
    const sw = document.createElement('span');
    sw.className = 'swatch';
    sw.style.background = pc.color;
    const meta = document.createElement('span');
    meta.className = 'piece-meta';
    meta.innerHTML = `<span class="no">#${pc.pieceNo}</span><span class="area">${pc.area} mm²</span><br>
      <span class="small muted">${pc.polygon.length} 顶点</span>`;
    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.className = 'color-pick';
    colorInput.value = pc.color;
    colorInput.title = '改颜色';
    colorInput.addEventListener('change', () => recolor(pc.id, colorInput.value));
    const editBtn = document.createElement('button');
    editBtn.className = 'icon-btn';
    editBtn.title = '编辑顶点（载入到画布）';
    editBtn.textContent = '✏️';
    editBtn.addEventListener('click', () => editPiece(pc));
    const delBtn = document.createElement('button');
    delBtn.className = 'icon-btn danger';
    delBtn.title = '删除';
    delBtn.textContent = '🗑';
    delBtn.addEventListener('click', () => removePiece(pc.id));
    li.append(sw, meta, colorInput, editBtn, delBtn);
    ul.appendChild(li);
  }
}

async function recolor(id, color) {
  const pc = state.draft.pieces.find((p) => p.id === id);
  try {
    const data = await api('PUT', `/api/designs/${state.draft.id}/pieces/${id}`,
      { color, polygon: pc.polygon });
    state.draft = data.draft;
    renderAllDraft();
  } catch (err) {
    showError(err.data?.error ? err.data : { error: err.message });
  }
}

function editPiece(pc) {
  state.editingId = pc.id;
  state.drawing = { points: pc.polygon.map((p) => p.slice()) };
  document.getElementById('pieceColor').value = pc.color;
  syncCoordsText();
  document.getElementById('editHint').textContent =
    `正在编辑 #${pc.pieceNo}：可修改坐标文本后“闭合多边形”保存，或取消放弃。`;
  renderDraft();
}

async function removePiece(id) {
  if (!confirm('确定删除这片拼片？（仅影响草稿）')) return;
  try {
    const data = await api('DELETE', `/api/designs/${state.draft.id}/pieces/${id}`);
    state.draft = data.draft;
    renderAllDraft();
  } catch (err) {
    showError({ error: err.message });
  }
}

function renderCoverage() {
  const c = state.draft.coverage;
  const box = document.getElementById('coverageStatus');
  if (c.covered) {
    box.innerHTML = `<span class="badge ok">✓ 完整覆盖，无空隙</span>
      <div class="muted">玻璃总面积 ${c.totalPieceArea} mm² ＝ 窗框面积 ${c.frameArea} mm²，可以发布。</div>`;
  } else {
    let html = `<span class="badge bad">✗ 尚未完整覆盖</span>`;
    if (c.gaps.length) {
      html += `<div class="gap-info">检测到 ${c.gaps.length} 个缺口（图中红色斜纹）：<br>` +
        c.gaps.map((g, i) => `缺口${i + 1}：面积 ${g.area} mm²`).join('<br>') + '</div>';
    }
    if (c.overlapping.length) {
      html += `<div class="gap-info">存在 ${c.overlapping.length} 处面积重叠（紫色区域），发布前必须修正。</div>`;
    }
    html += `<div class="muted">已覆盖 ${c.totalPieceArea} / ${c.frameArea} mm²</div>`;
    box.innerHTML = html;
  }
}

function renderLeadList() {
  const L = state.draft.leadList;
  const el = document.getElementById('leadList');
  let html = '<table><thead><tr><th>#</th><th>起点→终点</th><th class="num">长度 mm</th></tr></thead><tbody>';
  L.internal.forEach((r) => {
    const a = r.points[0], b = r.points[r.points.length - 1];
    html += `<tr><td>${r.no}</td><td>(${a[0]},${a[1]}) → (${b[0]},${b[1]})${r.points.length > 2 ? ` <span class="muted">(${r.points.length - 1} 段合并)</span>` : ''}</td><td class="num">${fmt(r.length)}</td></tr>`;
  });
  html += `<tr class="totals"><td colspan="2">内部公共边小计（${L.internalCount} 根）</td><td class="num">${fmt(L.internalTotal)}</td></tr>`;
  html += '</tbody></table>';
  html += '<table><thead><tr><th>外框</th><th class="num">长度 mm</th></tr></thead><tbody>';
  L.frameBars.forEach((b) => {
    html += `<tr><td>${b.name}</td><td class="num">${fmt(b.length)}</td></tr>`;
  });
  html += `<tr class="totals"><td>外框小计（4 根）</td><td class="num">${fmt(L.frameTotal)}</td></tr>`;
  html += `<tr class="totals"><td>铅条总长</td><td class="num">${fmt(L.grandTotal)}</td></tr>`;
  html += '</tbody></table>';
  html += '<div class="hint">公共边无论一侧整边、另一侧分几段，均合并为一根只计一次；长度先求和再四舍五入到 0.01 mm。</div>';
  el.innerHTML = html;
}

const fmt = (v) => (Math.round(v * 100) / 100).toFixed(2);

// ================= 横幅 =================

let bannerTimer = null;
function showError(payload) {
  state.error = payload;
  const b = document.getElementById('errorBanner');
  b.className = 'banner error';
  b.hidden = false;
  let txt = `⛔ ${payload.error}`;
  if (payload.at) txt += `　位置：(${payload.at[0]}, ${payload.at[1]}) mm`;
  if (payload.gaps?.length) txt += `<br>缺口面积：${payload.gaps.map((g) => g.area).join('、')} mm²`;
  b.innerHTML = txt;
  renderDraft();
}
function showSuccess(msg) {
  clearError();
  const b = document.getElementById('errorBanner');
  b.className = 'banner success';
  b.hidden = false;
  b.textContent = '✓ ' + msg;
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => { b.hidden = true; }, 2500);
}
function clearError() {
  state.error = null;
  document.getElementById('errorBanner').hidden = true;
}

// ================= 图纸加载 / 新建 =================

async function loadDraft(id) {
  cancelDrawing();
  const data = await api('GET', `/api/designs/${id}`);
  state.draft = data.draft;
  document.getElementById('designMeta').innerHTML =
    `<b>${escapeHtml(data.draft.name)}</b><br>窗框 ${data.draft.width} × ${data.draft.height} mm`;
  document.getElementById('editSection').hidden = false;
  document.getElementById('pieceListSection').hidden = false;
  document.getElementById('statusSection').hidden = false;
  state.drawing = null;
  renderAllDraft();
}

function renderAllDraft() {
  document.getElementById('designSelect').value = state.draft.id;
  renderDraft();
}

async function refreshDesignSelect(selectId, selectId2) {
  const data = await api('GET', '/api/designs');
  for (const id of [selectId, selectId2].filter(Boolean)) {
    const sel = document.getElementById(id);
    const prev = sel.value;
    sel.innerHTML = '';
    for (const d of data.designs) {
      const opt = document.createElement('option');
      opt.value = d.id;
      opt.textContent = `${d.name}（${d.width}×${d.height}mm）`;
      sel.appendChild(opt);
    }
    if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
  }
  return data.designs;
}

async function createDesign() {
  const name = document.getElementById('newName').value;
  const width = Number(document.getElementById('newWidth').value);
  const height = Number(document.getElementById('newHeight').value);
  try {
    const data = await api('POST', '/api/designs', { name, width, height });
    await refreshDesignSelect('designSelect', 'pubDesignSelect');
    document.getElementById('designSelect').value = data.design.id;
    await loadDraft(data.design.id);
  } catch (err) {
    alert(err.message);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ================= 发布 =================

async function publishDraft() {
  try {
    const data = await api('POST', `/api/designs/${state.draft.id}/publish`);
    showSuccess(`已发布为 v${data.publication.version}（历史版本不可修改）`);
  } catch (err) {
    const d = err.data || {};
    showError({
      error: d.error || err.message,
      gaps: d.gaps,
      at: d.gaps?.[0]?.polygon?.[0] || null,
    });
  }
}

// ================= 已发布视图 =================

const pubCanvas = document.getElementById('pubCanvas');
const pubCtx = pubCanvas.getContext('2d');
let currentPub = null;

async function loadPubDesignOptions() {
  await refreshDesignSelect('designSelect', 'pubDesignSelect');
  await loadPubVersions();
}

async function loadPubVersions() {
  const id = document.getElementById('pubDesignSelect').value;
  if (!id) return;
  const data = await api('GET', `/api/designs/${id}/publications`);
  const sel = document.getElementById('pubVersionSelect');
  sel.innerHTML = '';
  if (!data.publications.length) {
    sel.innerHTML = '<option value="">（暂无发布版）</option>';
    currentPub = null;
    renderPublished();
    return;
  }
  for (const p of data.publications) {
    const opt = document.createElement('option');
    opt.value = p.version;
    opt.textContent = `v${p.version} · ${p.publishedAt}`;
    sel.appendChild(opt);
  }
  await loadPubVersion(sel.value);
}

async function loadPubVersion(version) {
  const id = document.getElementById('pubDesignSelect').value;
  if (!id || !version) { currentPub = null; renderPublished(); return; }
  const data = await api('GET', `/api/designs/${id}/publications/${version}`);
  currentPub = data.publication;
  renderPublished();
}

function renderPublished() {
  pubCtx.clearRect(0, 0, pubCanvas.width, pubCanvas.height);
  document.getElementById('pubPieceList').innerHTML = '';
  document.getElementById('pubLeadList').innerHTML = '';
  document.getElementById('pubMeta').textContent = '';
  if (!currentPub) return;
  const { snapshot: s } = currentPub;
  const t = getTransform(s, pubCanvas);

  pubCtx.fillStyle = '#fbfaf7';
  pubCtx.fillRect(...t.toPx(0, s.height), s.width * t.scale, s.height * t.scale);
  for (const pc of s.pieces) {
    const pts = pc.polygon.map(([x, y]) => t.toPx(x, y));
    pubCtx.beginPath();
    pubCtx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) pubCtx.lineTo(pts[i][0], pts[i][1]);
    pubCtx.closePath();
    pubCtx.fillStyle = pc.color;
    pubCtx.globalAlpha = 0.82;
    pubCtx.fill();
    pubCtx.globalAlpha = 1;
    pubCtx.strokeStyle = '#222';
    pubCtx.lineWidth = 2;
    pubCtx.stroke();
    const [cx0, cy0] = centroid(pc.polygon);
    const [cx, cy] = t.toPx(cx0, cy0);
    pubCtx.font = 'bold 13px sans-serif';
    const label = `#${pc.pieceNo}`;
    const area = `${pc.area} mm²`;
    pubCtx.textAlign = 'center';
    pubCtx.textBaseline = 'middle';
    pubCtx.fillStyle = 'rgba(255,255,255,0.8)';
    const w1 = pubCtx.measureText(label).width;
    const w2 = pubCtx.measureText(area).width;
    pubCtx.fillRect(cx - Math.max(w1, w2) / 2 - 5, cy - 16, Math.max(w1, w2) + 10, 34);
    pubCtx.fillStyle = '#000';
    pubCtx.fillText(label, cx, cy - 7);
    pubCtx.font = '11px sans-serif';
    pubCtx.fillStyle = '#444';
    pubCtx.fillText(area, cx, cy + 9);
  }
  pubCtx.strokeStyle = '#111';
  pubCtx.lineWidth = 3.5;
  pubCtx.strokeRect(...t.toPx(0, s.height), s.width * t.scale, s.height * t.scale);

  document.getElementById('pubMeta').innerHTML =
    `<b>${escapeHtml(s.name)}</b> v${currentPub.version}<br>` +
    `${s.width} × ${s.height} mm · 发布于 ${currentPub.publishedAt}`;

  // 明细
  const ul = document.getElementById('pubPieceList');
  for (const pc of s.pieces) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="swatch" style="background:${pc.color}"></span>
      <span class="piece-meta"><span class="no">#${pc.pieceNo}</span>
      <span class="area">${pc.area} mm²</span></span>`;
    ul.appendChild(li);
  }

  // 清单
  const L = s.leadList;
  let html = '<table><thead><tr><th>#</th><th>起点→终点</th><th class="num">长度</th></tr></thead><tbody>';
  L.internal.forEach((r) => {
    const a = r.points[0], b = r.points[r.points.length - 1];
    html += `<tr><td>${r.no}</td><td>(${a[0]},${a[1]})→(${b[0]},${b[1]})</td><td class="num">${fmt(r.length)}</td></tr>`;
  });
  html += `<tr class="totals"><td colspan="2">内部公共边（${L.internalCount} 根）</td><td class="num">${fmt(L.internalTotal)}</td></tr>`;
  L.frameBars.forEach((b) => {
    html += `<tr><td>${b.name}</td><td></td><td class="num">${fmt(b.length)}</td></tr>`;
  });
  html += `<tr class="totals"><td colspan="2">外框</td><td class="num">${fmt(L.frameTotal)}</td></tr>`;
  html += `<tr class="totals"><td colspan="2">铅条总长</td><td class="num">${fmt(L.grandTotal)}</td></tr>`;
  html += '</tbody></table>';
  document.getElementById('pubLeadList').innerHTML = html;
}

// ================= 事件绑定与启动 =================

document.getElementById('tabDraft').addEventListener('click', () => switchTab('draft'));
document.getElementById('tabPublished').addEventListener('click', () => switchTab('published'));
document.getElementById('btnCreate').addEventListener('click', createDesign);
document.getElementById('designSelect').addEventListener('change', (e) => loadDraft(Number(e.target.value)));
document.getElementById('pubDesignSelect').addEventListener('change', loadPubVersions);
document.getElementById('pubVersionSelect').addEventListener('change', (e) => loadPubVersion(e.target.value));
document.getElementById('btnStart').addEventListener('click', () => {
  if (state.editingId) cancelDrawing();
  if (!state.drawing) startDrawing();
});
document.getElementById('btnFinish').addEventListener('click', () => {
  if (!state.drawing) {
    showError({ error: '请先点击“开始绘制新片”，或直接在文本框输入坐标' });
    return;
  }
  const parsed = coordsFromTextarea();
  if (parsed.error) { showError({ error: parsed.error }); return; }
  if (parsed.points.length) state.drawing.points = parsed.points;
  finishDrawing();
});
document.getElementById('btnUndo').addEventListener('click', () => {
  if (state.drawing?.points.length) {
    state.drawing.points.pop();
    syncCoordsText();
    renderDraft();
  }
});
document.getElementById('btnCancel').addEventListener('click', cancelDrawing);
document.getElementById('btnPublish').addEventListener('click', publishDraft);

function switchTab(which) {
  document.getElementById('tabDraft').classList.toggle('active', which === 'draft');
  document.getElementById('tabPublished').classList.toggle('active', which === 'published');
  document.getElementById('viewDraft').hidden = which !== 'draft';
  document.getElementById('viewPublished').hidden = which !== 'published';
  if (which === 'published') loadPubVersions();
}

(async function init() {
  const designs = await refreshDesignSelect('designSelect', 'pubDesignSelect');
  if (designs.length) {
    document.getElementById('designSelect').value = designs[0].id;
    await loadDraft(designs[0].id);
  } else {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#888';
    ctx.font = '16px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('请在左侧“新建图纸”，输入正整数毫米的窗框宽高', canvas.width / 2, canvas.height / 2);
  }
})();
