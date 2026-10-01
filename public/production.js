'use strict';

// 铅条生产视图：原材登记/补货、依据发布版预览与制作计划、确认（原子预留）/取消。
// 与 app.js 的标签切换协作：app.js 只切换草稿/发布两个视图，本文件接管生产视图。

const fmt2 = (v) => (Math.round(v * 100) / 100).toFixed(2);

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function papi(method, url, body) {
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
    throw err;
  }
  return data;
}

// ---------- 标签切换 ----------

function showProduction() {
  document.getElementById('tabDraft').classList.remove('active');
  document.getElementById('tabPublished').classList.remove('active');
  document.getElementById('tabProduction').classList.add('active');
  document.getElementById('viewDraft').hidden = true;
  document.getElementById('viewPublished').hidden = true;
  document.getElementById('viewProduction').hidden = false;
  refreshAll();
}
document.getElementById('tabProduction').addEventListener('click', showProduction);
for (const id of ['tabDraft', 'tabPublished']) {
  document.getElementById(id).addEventListener('click', () => {
    document.getElementById('viewProduction').hidden = true;
    document.getElementById('tabProduction').classList.remove('active');
  });
}

// ---------- 原材 ----------

let materials = [];
let restockMaterialId = null;

async function loadMaterials() {
  const data = await papi('GET', '/api/lead-materials');
  materials = data.materials;
  renderMaterials();
  renderMaterialSelect();
}

function renderMaterials() {
  const tbody = document.querySelector('#materialTable tbody');
  tbody.innerHTML = '';
  if (!materials.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="muted">尚未登记原材</td></tr>';
    return;
  }
  for (const m of materials) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td class="num">${fmt2(m.length)}</td>
      <td class="num">${m.stockCount}</td>
      <td class="num">${m.reservedCount}</td>
      <td class="num"><b>${m.availableCount}</b></td>
      <td><button class="icon-btn" title="补货">➕</button></td>`;
    tr.querySelector('button').addEventListener('click', () => openRestock(m));
    tbody.appendChild(tr);
  }
}

function renderMaterialSelect() {
  const sel = document.getElementById('planMaterialSelect');
  const prev = sel.value;
  sel.innerHTML = '';
  if (!materials.length) sel.innerHTML = '<option value="">（请先登记原材）</option>';
  for (const m of materials) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = `${fmt2(m.length)} mm（可用 ${m.availableCount}/${m.stockCount} 根）`;
    sel.appendChild(opt);
  }
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

async function addMaterial() {
  const length = Number(document.getElementById('matLength').value);
  const stockCount = Number(document.getElementById('matStock').value || 0);
  try {
    await papi('POST', '/api/lead-materials', { length, stockCount });
    document.getElementById('matLength').value = '';
    document.getElementById('matStock').value = '';
    await loadMaterials();
    planMsg('✓ 原材已登记', 'ok');
  } catch (err) { planMsg('⛔ ' + err.message, 'err'); }
}

function openRestock(m) {
  restockMaterialId = m.id;
  document.getElementById('restockRow').hidden = false;
  document.getElementById('restockName').textContent = `${fmt2(m.length)} mm`;
  document.getElementById('restockCount').value = '';
  document.getElementById('restockCount').focus();
}

async function doRestock() {
  const addCount = Number(document.getElementById('restockCount').value);
  try {
    await papi('POST', `/api/lead-materials/${restockMaterialId}/restock`, { addCount });
    document.getElementById('restockRow').hidden = true;
    restockMaterialId = null;
    await loadMaterials();
    await loadPlans();
    planMsg('✓ 补货完成', 'ok');
  } catch (err) { planMsg('⛔ ' + err.message, 'err'); }
}

// ---------- 图纸/版本选择 ----------

async function loadPlanDesigns() {
  const data = await papi('GET', '/api/designs');
  const sel = document.getElementById('planDesignSelect');
  const prev = sel.value;
  sel.innerHTML = '';
  for (const d of data.designs) {
    const opt = document.createElement('option');
    opt.value = d.id;
    opt.textContent = `${d.name}（v${d.latest_version || '-'}）`;
    sel.appendChild(opt);
  }
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
  await loadPlanVersions();
}

async function loadPlanVersions() {
  const id = document.getElementById('planDesignSelect').value;
  const sel = document.getElementById('planVersionSelect');
  sel.innerHTML = '';
  if (!id) return;
  const data = await papi('GET', `/api/designs/${id}/publications`);
  if (!data.publications.length) {
    sel.innerHTML = '<option value="">（暂无发布版）</option>';
    return;
  }
  for (const p of data.publications) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = `v${p.version} · ${p.publishedAt}`;
    sel.appendChild(opt);
  }
}

// ---------- 预览 / 制作 ----------

function readPlanForm() {
  return {
    publicationId: Number(document.getElementById('planVersionSelect').value),
    materialId: Number(document.getElementById('planMaterialSelect').value),
    copies: Number(document.getElementById('planCopies').value),
    kerf: Number(document.getElementById('planKerf').value),
  };
}

let lastPreview = null;

async function preview() {
  const f = readPlanForm();
  try {
    const data = await papi('POST', '/api/lead-plans/preview', f);
    lastPreview = data.preview;
    renderCutting(data.preview, { preview: true });
    if (data.preview.feasible) {
      planMsg(`✓ 需用 ${data.preview.neededCount} 根（可用 ${data.preview.availableCount} 根），预览不占库存`, 'ok');
    } else {
      planMsg(`⚠ 需用 ${data.preview.neededCount} 根，可用仅 ${data.preview.availableCount} 根，缺口 ${data.preview.shortage} 根；可存草稿但不能确认`, 'warn');
    }
  } catch (err) {
    lastPreview = null;
    renderCutting(null);
    planMsg('⛔ ' + err.message, 'err');
  }
}

async function createPlan() {
  const f = readPlanForm();
  try {
    const data = await papi('POST', '/api/lead-plans', f);
    planMsg(`✓ 计划 #${data.plan.id} 已保存为草稿（不占库存）`, 'ok');
    await loadPlans();
    showPlan(data.plan.id);
  } catch (err) { planMsg('⛔ ' + err.message, 'err'); }
}

function planMsg(text, kind) {
  const el = document.getElementById('planMsg');
  el.textContent = text;
  el.className = 'hint ' + (kind === 'ok' ? 'msg-ok' : kind === 'warn' ? 'msg-warn' : kind === 'err' ? 'msg-err' : '');
}

// ---------- 计划列表 / 详情 ----------

let plans = [];

async function loadPlans() {
  const data = await papi('GET', '/api/lead-plans');
  plans = data.plans;
  const tbody = document.querySelector('#planListTable tbody');
  tbody.innerHTML = '';
  if (!plans.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="muted">暂无计划</td></tr>';
    return;
  }
  for (const p of plans) {
    const tr = document.createElement('tr');
    const statusTxt = { draft: '草稿', confirmed: '已确认', cancelled: '已取消' }[p.status];
    tr.innerHTML = `<td><a href="#" class="plan-link">#${p.id}</a></td>
      <td>v${p.version} ×${p.copies}</td>
      <td class="num">${p.neededCount}</td>
      <td><span class="plan-status ${p.status}">${statusTxt}</span></td>
      <td>${p.status === 'draft' ? '<button class="icon-btn confirm" title="确认并预留库存">✓</button><button class="icon-btn cancel" title="取消">✕</button>' : ''}</td>`;
    tr.querySelector('.plan-link').addEventListener('click', (e) => { e.preventDefault(); showPlan(p.id); });
    tr.querySelector('.confirm')?.addEventListener('click', () => confirmPlan(p.id));
    tr.querySelector('.cancel')?.addEventListener('click', () => cancelPlan(p.id));
    tbody.appendChild(tr);
  }
}

async function showPlan(id) {
  const data = await papi('GET', `/api/lead-plans/${id}`);
  renderCutting(data.plan, { preview: false });
}

async function confirmPlan(id) {
  try {
    await papi('POST', `/api/lead-plans/${id}/confirm`);
    planMsg('✓ 已确认，库存已原子预留', 'ok');
  } catch (err) {
    const d = err.data || {};
    if (d.shortage != null) {
      planMsg(`⛔ ${err.message}：缺口 ${d.shortage} 根（需用 ${d.needed} / 可用 ${d.available}）`, 'err');
    } else planMsg('⛔ ' + err.message, 'err');
  }
  await Promise.all([loadPlans(), loadMaterials()]);
  showPlan(id);
}

async function cancelPlan(id) {
  if (!confirm('确定取消该草稿计划？（不会改变库存）')) return;
  try {
    await papi('POST', `/api/lead-plans/${id}/cancel`);
    planMsg('✓ 计划已取消，库存未变化', 'ok');
  } catch (err) { planMsg('⛔ ' + err.message, 'err'); }
  await Promise.all([loadPlans(), loadMaterials()]);
  showPlan(id);
}

// ---------- 排产结果渲染（预览与计划详情共用） ----------

function renderCutting(c, opts = {}) {
  const el = document.getElementById('planDetail');
  if (!c) { el.innerHTML = ''; return; }
  const title = opts.preview ? '排产预览（不占库存）' : `生产计划 #${c.id} · ${({ draft: '草稿', confirmed: '已确认', cancelled: '已取消' })[c.status]}`;
  const shortageLine = c.shortage > 0
    ? `<div class="msg-warn box">⚠ 需用 <b>${c.neededCount}</b> 根，库存可用 <b>${c.availableCount}</b> 根，缺口 <b>${c.shortage}</b> 根${c.status === 'draft' ? '，确认将被拒绝' : ''}</div>`
    : `<div class="msg-ok box">✓ 库存充足：需用 ${c.neededCount} 根 / 可用 ${c.availableCount} 根</div>`;
  let html = `<div class="cutting-head"><h2>${esc(title)}</h2>
    <div class="muted">图纸 #${c.designId} · 发布 v${c.version} · ${c.copies} 件 · 原材 ${fmt2(c.materialLength)} mm · 每刀损耗 ${fmt2(c.kerf)} mm</div>
    ${shortageLine}
    <div class="muted">切段 ${c.segmentCount} 段；成品合计 ${fmt2(c.totalProduct)} mm，损耗合计 ${fmt2(c.totalKerf)} mm，占用合计 ${fmt2(c.totalUsed)} mm</div>
    </div>`;
  for (const bin of c.bins) {
    html += `<div class="bin-card"><h3>第 ${bin.no} / ${c.neededCount} 根原材
      <span class="muted">（占用 ${fmt2(bin.used)} mm，余料 <b>${fmt2(bin.remainder)}</b> mm）</span></h3>
      <table><thead><tr><th>顺序</th><th>切段（第n件）</th><th class="num">成品 mm</th><th class="num">损耗 mm</th><th class="num">占用 mm</th></tr></thead><tbody>`;
    for (const s of bin.cuts) {
      html += `<tr><td>${s.order}</td><td>${esc(s.label)}（第 ${s.copyNo} 件）</td>
        <td class="num">${fmt2(s.length)}</td><td class="num">${fmt2(s.kerf)}</td><td class="num">${fmt2(s.occupied)}</td></tr>`;
    }
    html += '</tbody></table></div>';
  }
  el.innerHTML = html;
}

// ---------- 事件与初始化 ----------

document.getElementById('btnAddMaterial').addEventListener('click', addMaterial);
document.getElementById('btnRestock').addEventListener('click', doRestock);
document.getElementById('btnRestockCancel').addEventListener('click', () => {
  document.getElementById('restockRow').hidden = true;
  restockMaterialId = null;
});
document.getElementById('planDesignSelect').addEventListener('change', loadPlanVersions);
document.getElementById('btnPreview').addEventListener('click', preview);
document.getElementById('btnCreatePlan').addEventListener('click', createPlan);

async function refreshAll() {
  await Promise.all([loadPlanDesigns(), loadMaterials(), loadPlans()]);
}
