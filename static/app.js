'use strict';
const $ = s => document.querySelector(s);
const MODELS = ['High Grade', 'Standard', 'Charge', 'Pet'];
const PREFIX = { 'High Grade': 'HG', 'Standard': 'ST', 'Charge': 'CH', 'Pet': 'PT' };
const STATUS_LABEL = { in_stock: '在庫', sold: '已售', trial: '試用機', retired: '除役' };
const fmt = n => '$' + (n || 0).toLocaleString('zh-TW');
const today = () => new Date().toLocaleDateString('sv-SE');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let D = null;
let tab = 'sales';

/* ---------- api ---------- */
async function api(path, opts = {}) {
  if (opts.body) {
    opts.method = opts.method || 'POST';
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(opts.body);
  }
  const r = await fetch(path, opts);
  if (r.status === 401) { showLogin(); throw new Error('unauthorized'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { alert(j.error || '發生錯誤'); throw new Error(j.error || r.status); }
  return j;
}
async function load() {
  D = await api('/api/data');
  hideLogin();
  render();
}

/* ---------- login ---------- */
function showLogin() {
  $('#login').classList.remove('hidden');
  ['#topbar', '#main', '#tabs', '#fab'].forEach(s => $(s).classList.add('hidden'));
  setTimeout(() => $('#pw').focus(), 50);
}
function hideLogin() {
  $('#login').classList.add('hidden');
  ['#topbar', '#main', '#tabs', '#fab'].forEach(s => $(s).classList.remove('hidden'));
}
async function doLogin() {
  $('#loginMsg').textContent = '';
  try {
    const r = await fetch('/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: $('#pw').value })
    });
    if (!r.ok) { $('#loginMsg').textContent = '密碼錯誤'; return; }
    $('#pw').value = '';
    await load();
  } catch { $('#loginMsg').textContent = '無法連線'; }
}
$('#loginBtn').onclick = doLogin;
$('#pw').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
$('#logoutBtn').onclick = async () => { await fetch('/api/logout', { method: 'POST' }); showLogin(); };

/* ---------- modal ---------- */
function openModal(html) {
  $('#modalCard').innerHTML = html;
  $('#modal').classList.remove('hidden');
}
function closeModal() { $('#modal').classList.add('hidden'); $('#modalCard').innerHTML = ''; }
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });

/* ---------- tabs ---------- */
document.querySelectorAll('nav button').forEach(b => {
  b.onclick = () => {
    tab = b.dataset.tab;
    document.querySelectorAll('nav button').forEach(x => x.classList.toggle('active', x === b));
    render();
  };
});
$('#fab').onclick = () => openModal(`<h2>新增</h2>
  <div class="menu-grid">
    <button class="btn big" onclick="closeModal();openSaleForm()">💰 銷售</button>
    <button class="btn big" onclick="closeModal();openPurchaseForm()">📦 進貨</button>
    <button class="btn big" onclick="closeModal();openTrialForm()">🧪 試用</button>
  </div>`);

function render() {
  const m = $('#main');
  if (!D) return;
  if (tab === 'sales') m.innerHTML = viewSales();
  else if (tab === 'purchases') m.innerHTML = viewPurchases();
  else if (tab === 'trials') m.innerHTML = viewTrials();
  else if (tab === 'stock') m.innerHTML = viewStock();
  else m.innerHTML = viewReport();
}

/* ---------- sales ---------- */
function viewSales() {
  if (!D.sales.length) return '<div class="empty">尚無銷售紀錄，按＋新增</div>';
  const byMonth = {};
  D.sales.forEach(s => { (byMonth[s.date.slice(0, 7)] = byMonth[s.date.slice(0, 7)] || []).push(s); });
  return Object.keys(byMonth).sort().reverse().map(ym => {
    const rows = byMonth[ym];
    const rev = rows.reduce((a, s) => a + s.price - s.card_fee, 0);
    const profit = rows.reduce((a, s) => a + s.price - s.card_fee - s.cost, 0);
    return `<h2 class="section">${ym}　銷售 ${fmt(rev)}｜毛利 ${fmt(profit)}｜${rows.length} 台</h2>` +
      rows.map(s => {
        const p = s.price - s.card_fee - s.cost;
        return `<div class="card row" onclick="openSaleEditForm(${s.id})" style="cursor:pointer">
          <div class="grow">
            <div class="title">${esc(s.customer)} <span class="badge">${esc(s.model)}</span></div>
            <div class="sub">${s.date}${s.serial ? '｜' + esc(s.serial) : ''}${s.warranty_no ? '｜保固 ' + esc(s.warranty_no) : ''}${s.card_fee ? '｜刷卡費 ' + fmt(s.card_fee) : ''}${s.note ? '｜' + esc(s.note) : ''}</div>
          </div>
          <div class="amount">${fmt(s.price - s.card_fee)}<div class="sub ${p >= 0 ? 'pos' : 'neg'}">毛利 ${fmt(p)}</div></div>
          <button class="icon-btn" onclick="event.stopPropagation();delSale(${s.id})">🗑</button>
        </div>`;
      }).join('');
  }).join('');
}
async function delSale(id) {
  if (!confirm('刪除此筆銷售？機器會回到庫存。')) return;
  await api('/api/sale/' + id, { method: 'DELETE' });
  await load();
}

function openSaleEditForm(id) {
  const s = D.sales.find(x => x.id === id);
  if (!s) return;
  openModal(`<h2>編輯銷售</h2>
    <div class="two">
      <div class="field"><label>日期</label><input id="f_date" type="date" value="${s.date}"></div>
      <div class="field"><label>客戶</label><input id="f_cust" list="custList" value="${esc(s.customer)}">
        <datalist id="custList">${D.customers.map(c => `<option value="${esc(c)}">`).join('')}</datalist></div>
    </div>
    <div class="field"><label>型號</label><div class="seg" id="f_models"></div></div>
    <div class="two">
      <div class="field"><label>貨號${s.unit_id ? '（同步更新機器）' : ''}</label><input id="f_serial" value="${esc(s.serial)}"></div>
      <div class="field"><label>保證書編號</label><input id="f_warranty" value="${esc(s.warranty_no || '')}"></div>
    </div>
    <div class="two">
      <div class="field"><label>銷售單價（此筆單台）</label><input id="f_price" type="number" inputmode="numeric" value="${s.price}"></div>
      <div class="field"><label>刷卡手續費</label><input id="f_fee" type="number" inputmode="numeric" value="${s.card_fee}"></div>
    </div>
    <div class="two">
      <div class="field"><label>進貨成本</label><input id="f_cost" type="number" inputmode="numeric" value="${s.cost}"></div>
      <div class="field"><label>備註</label><input id="f_note" value="${esc(s.note)}"></div>
    </div>
    <div class="preview" id="f_preview"></div>
    <div class="form-actions">
      <button class="btn" onclick="closeModal()">取消</button>
      <button class="btn primary" onclick="submitSaleEdit(${s.id})">儲存</button>
    </div>`);
  let model = s.model;
  const renderModels = () => {
    $('#f_models').innerHTML = MODELS.map(mo =>
      `<button class="${mo === model ? 'on' : ''}" data-m="${esc(mo)}">${esc(mo)}</button>`).join('');
    $('#f_models').querySelectorAll('button').forEach(b => b.onclick = () => { model = b.dataset.m; renderModels(); });
  };
  const preview = () => {
    const price = +$('#f_price').value || 0, fee = +$('#f_fee').value || 0, cost = +$('#f_cost').value || 0;
    const rev = price - fee, p = rev - cost;
    $('#f_preview').innerHTML =
      `實收 <b>${fmt(rev)}</b>｜成本 ${fmt(cost)}｜毛利 <b class="${p >= 0 ? 'pos' : 'neg'}">${fmt(p)}</b>`;
  };
  ['#f_price', '#f_fee', '#f_cost'].forEach(sel => $(sel).oninput = preview);
  renderModels(); preview();
  window._seModel = () => model;
}
async function submitSaleEdit(id) {
  await api('/api/sale/' + id, {
    method: 'PATCH',
    body: {
      date: $('#f_date').value, customer: $('#f_cust').value.trim(),
      model: window._seModel(), serial: $('#f_serial').value.trim(),
      price: +$('#f_price').value || 0, card_fee: +$('#f_fee').value || 0,
      cost: +$('#f_cost').value || 0, warranty_no: $('#f_warranty').value.trim(),
      note: $('#f_note').value.trim()
    }
  });
  closeModal(); await load();
}

function openSaleForm() {
  const avail = D.units.filter(u => u.status === 'in_stock');
  if (!avail.length) { alert('目前沒有在庫機器，請先登記進貨'); return; }
  openModal(`<h2>新增銷售</h2>
    <div class="two">
      <div class="field"><label>日期</label><input id="f_date" type="date" value="${today()}"></div>
      <div class="field"><label>客戶</label><input id="f_cust" list="custList" placeholder="人名">
        <datalist id="custList">${D.customers.map(c => `<option value="${esc(c)}">`).join('')}</datalist></div>
    </div>
    <div class="field"><label>型號</label><div class="seg" id="f_models"></div></div>
    <div class="field"><label>貨號（可多選）</label><div class="unit-chips" id="f_units"></div></div>
    <div class="field hidden" id="f_fixwrap"><label>貨號確認／更正（賣出時填實際貨號）</label><div id="f_fixes"></div></div>
    <div class="two">
      <div class="field"><label id="f_price_lbl">銷售單價</label><input id="f_price" type="number" inputmode="numeric" placeholder="0"></div>
      <div class="field"><label>刷卡手續費（選填）</label><input id="f_fee" type="number" inputmode="numeric" placeholder="0"></div>
    </div>
    <div class="two">
      <div class="field"><label>保證書編號（選填）</label><input id="f_warranty" placeholder="保固卡編號"></div>
      <div class="field"><label>備註（選填）</label><input id="f_note" placeholder="折扣、付款方式…"></div>
    </div>
    <div class="preview" id="f_preview"></div>
    <div class="form-actions">
      <button class="btn" onclick="closeModal()">取消</button>
      <button class="btn primary" onclick="submitSale()">儲存</button>
    </div>`);
  let model = 'ALL';
  const sel = new Set();
  const fixVals = {};
  const renderModels = () => {
    $('#f_models').innerHTML =
      `<button class="${model === 'ALL' ? 'on' : ''}" data-m="ALL">全部（${avail.length}）</button>` +
      MODELS.map(mo => {
        const n = avail.filter(u => u.model === mo).length;
        return `<button ${n ? '' : 'disabled'} class="${mo === model ? 'on' : ''}" data-m="${esc(mo)}">${esc(mo)}（${n}）</button>`;
      }).join('');
    $('#f_models').querySelectorAll('button').forEach(b => b.onclick = () => { model = b.dataset.m; renderModels(); renderUnits(); });
  };
  const renderUnits = () => {
    $('#f_units').innerHTML = avail.filter(u => model === 'ALL' || u.model === model).map(u =>
      `<button class="${sel.has(u.id) ? 'on' : ''}" data-id="${u.id}">${esc(u.serial)}<span class="c">${model === 'ALL' ? esc(u.model) + '｜' : ''}成本 ${fmt(u.cost)}</span></button>`
    ).join('');
    $('#f_units').querySelectorAll('button').forEach(b => b.onclick = () => {
      const id = +b.dataset.id;
      sel.has(id) ? sel.delete(id) : sel.add(id);
      renderUnits(); renderFixes(); preview();
    });
  };
  const renderFixes = () => {
    $('#f_fixwrap').classList.toggle('hidden', !sel.size);
    $('#f_fixes').innerHTML = [...sel].map(id => {
      const u = avail.find(x => x.id === id);
      return `<input class="fix-in" style="margin-bottom:8px" data-id="${id}" placeholder="${esc(u.serial)}（實際貨號）" value="${esc(fixVals[id] ?? u.serial)}">`;
    }).join('');
    document.querySelectorAll('.fix-in').forEach(inp => inp.oninput = () => { fixVals[+inp.dataset.id] = inp.value; });
  };
  const preview = () => {
    const n = sel.size, total = +$('#f_price').value || 0, fee = +$('#f_fee').value || 0;
    $('#f_price_lbl').textContent = n > 1 ? `銷售總價（${n} 台合計）` : '銷售單價';
    const cost = [...sel].reduce((a, id) => a + avail.find(u => u.id === id).cost, 0);
    const rev = total - fee;
    $('#f_preview').innerHTML = n
      ? `已選 ${n} 台｜實收 <b>${fmt(rev)}</b>｜成本 ${fmt(cost)}｜毛利 <b class="${rev - cost >= 0 ? 'pos' : 'neg'}">${fmt(rev - cost)}</b>`
      : '請選擇貨號';
  };
  $('#f_price').oninput = preview; $('#f_fee').oninput = preview;
  renderModels(); renderUnits(); renderFixes(); preview();
  window._saleSel = sel;
  window._saleFix = () => {
    const out = {};
    [...sel].forEach(id => {
      const u = avail.find(x => x.id === id);
      const v = (fixVals[id] ?? '').trim();
      if (v && v !== u.serial) out[id] = v;
    });
    return out;
  };
}
async function submitSale() {
  const sel = window._saleSel;
  await api('/api/sale', {
    body: {
      date: $('#f_date').value, customer: $('#f_cust').value.trim(),
      unit_ids: [...sel], total_price: +$('#f_price').value || 0,
      card_fee: +$('#f_fee').value || 0, warranty_no: $('#f_warranty').value.trim(),
      serial_fix: window._saleFix(), note: $('#f_note').value.trim()
    }
  });
  closeModal(); await load();
}

/* ---------- purchases ---------- */
function viewPurchases() {
  if (!D.purchases.length) return '<div class="empty">尚無進貨紀錄，按＋新增</div>';
  return D.purchases.map(p => {
    const nTrial = D.units.filter(u => u.purchase_id === p.id && u.status === 'trial').length;
    return `<div class="card row" onclick="openPurchaseEditForm(${p.id})" style="cursor:pointer">
      <div class="grow">
        <div class="title">${esc(p.model)} × ${p.qty}${nTrial ? ` <span class="badge warn">🧪 試用機 ${nTrial}</span>` : ''}</div>
        <div class="sub">${p.date}${p.note ? '｜' + esc(p.note) : ''}</div>
      </div>
      <div class="amount">${fmt(p.total)}</div>
      <button class="icon-btn" onclick="event.stopPropagation();delPurchase(${p.id})">🗑</button>
    </div>`;
  }).join('');
}
async function delPurchase(id) {
  if (!confirm('刪除此筆進貨？其貨號一併刪除（已售出者無法刪）。')) return;
  await api('/api/purchase/' + id, { method: 'DELETE' });
  await load();
}

function openPurchaseEditForm(id) {
  const p = D.purchases.find(x => x.id === id);
  if (!p) return;
  const units = D.units.filter(u => u.purchase_id === p.id);
  const unitList = units.length
    ? `<div class="field"><label>此筆機器（於庫存頁編輯貨號）</label><div class="unit-chips">` +
      units.map(u => `<button disabled style="opacity:.75">${esc(u.serial)}<span class="c">${STATUS_LABEL[u.status]}｜成本 ${fmt(u.cost)}</span></button>`).join('') +
      `</div></div>`
    : '';
  openModal(`<h2>編輯進貨</h2>
    <div class="two">
      <div class="field"><label>日期</label><input id="f_date" type="date" value="${p.date}"></div>
      <div class="field"><label>型號</label><input id="f_model" list="modelList" value="${esc(p.model)}">
        <datalist id="modelList">${MODELS.map(m => `<option value="${esc(m)}">`).join('')}</datalist></div>
    </div>
    <div class="field"><label>金額（總額）</label><input id="f_total" type="number" inputmode="numeric" value="${p.total}"></div>
    ${unitList}
    <div class="field"><label>備註</label><input id="f_note" value="${esc(p.note)}"></div>
    <div class="preview" id="f_preview"></div>
    <div class="form-actions">
      <button class="btn" onclick="closeModal()">取消</button>
      <button class="btn primary" onclick="submitPurchaseEdit(${p.id})">儲存</button>
    </div>`);
  const preview = () => {
    const total = +$('#f_total').value || 0;
    $('#f_preview').innerHTML = units.length
      ? `改金額會重算 ${units.length} 台的單機成本（約 ${fmt(Math.floor(total / units.length))}／台）。已售出紀錄的成本不會變動，如需修正請至銷售頁編輯該筆。`
      : '此筆為 Excel 匯入的帳目紀錄，未連結機器，僅更新顯示金額。';
  };
  $('#f_total').oninput = preview;
  preview();
}
async function submitPurchaseEdit(id) {
  await api('/api/purchase/' + id, {
    method: 'PATCH',
    body: {
      date: $('#f_date').value, model: $('#f_model').value.trim(),
      total: +$('#f_total').value || 0, note: $('#f_note').value.trim()
    }
  });
  closeModal(); await load();
}
function openPurchaseForm() {
  openModal(`<h2>新增進貨</h2>
    <div class="two">
      <div class="field"><label>日期</label><input id="f_date" type="date" value="${today()}"></div>
      <div class="field"><label>數量</label><input id="f_qty" type="number" inputmode="numeric" value="1" min="1"></div>
    </div>
    <div class="field"><label>型號</label><div class="seg" id="f_models"></div></div>
    <div class="field"><label>入庫類型</label><div class="seg" id="f_ptype"></div></div>
    <div class="field"><label>金額（總額）</label><input id="f_total" type="number" inputmode="numeric" placeholder="0"></div>
    <div class="field"><label>貨號（每台一個）<button class="btn" style="min-height:34px;padding:4px 12px;font-size:14px;margin-left:8px" onclick="autoSerials()">自動產生</button></label>
      <div id="f_serials"></div></div>
    <div class="field"><label>備註（選填）</label><input id="f_note" placeholder="供應商、發票號碼…"></div>
    <div class="form-actions">
      <button class="btn" onclick="closeModal()">取消</button>
      <button class="btn primary" onclick="submitPurchase()">儲存</button>
    </div>`);
  let model = 'High Grade';
  let ptype = 'in_stock';
  const renderModels = () => {
    $('#f_models').innerHTML = MODELS.map(mo =>
      `<button class="${mo === model ? 'on' : ''}" data-m="${esc(mo)}">${esc(mo)}</button>`).join('');
    $('#f_models').querySelectorAll('button').forEach(b => b.onclick = () => { model = b.dataset.m; renderModels(); });
  };
  const renderPtype = () => {
    $('#f_ptype').innerHTML =
      `<button class="${ptype === 'in_stock' ? 'on' : ''}" data-t="in_stock">一般庫存</button>` +
      `<button class="${ptype === 'trial' ? 'on' : ''}" data-t="trial">試用機 🧪</button>`;
    $('#f_ptype').querySelectorAll('button').forEach(b => b.onclick = () => { ptype = b.dataset.t; renderPtype(); });
  };
  const renderSerials = () => {
    const n = Math.max(1, Math.min(50, +$('#f_qty').value || 1));
    const cur = [...document.querySelectorAll('.serial-in')].map(i => i.value);
    $('#f_serials').innerHTML = Array.from({ length: n }, (_, i) =>
      `<input class="serial-in" style="margin-bottom:8px" placeholder="第 ${i + 1} 台貨號" value="${esc(cur[i] || '')}">`).join('');
  };
  window._pModel = () => model;
  window._pType = () => ptype;
  window.autoSerials = () => {
    const d = ($('#f_date').value || today()).replaceAll('-', '').slice(2);
    const t = ptype === 'trial' ? 'T' : '';
    document.querySelectorAll('.serial-in').forEach((inp, i) => {
      inp.value = `${PREFIX[model] || 'XX'}${d}-${t}${i + 1}`;
    });
  };
  $('#f_qty').oninput = renderSerials;
  renderModels(); renderPtype(); renderSerials();
}
async function submitPurchase() {
  await api('/api/purchase', {
    body: {
      date: $('#f_date').value, model: window._pModel(),
      total: +$('#f_total').value || 0, status: window._pType(),
      serials: [...document.querySelectorAll('.serial-in')].map(i => i.value.trim()),
      note: $('#f_note').value.trim()
    }
  });
  closeModal(); await load();
}

/* ---------- trials ---------- */
function viewTrials() {
  const act = D.trials.filter(t => !t.returned);
  const done = D.trials.filter(t => t.returned);
  const now = today();
  const item = t => {
    let due = '';
    if (t.end_date && !t.returned) {
      const days = Math.ceil((new Date(t.end_date) - new Date(now)) / 86400000);
      due = days < 0 ? `<span class="badge bad">逾期 ${-days} 天</span>`
        : days <= 3 ? `<span class="badge warn">剩 ${days} 天</span>`
        : `<span class="badge ok">剩 ${days} 天</span>`;
    }
    return `<div class="card row" onclick="openTrialEditForm(${t.id})" style="cursor:pointer">
      <div class="grow">
        <div class="title">${esc(t.customer) || '—'} ${t.model ? `<span class="badge">${esc(t.model)}</span>` : ''} ${due}</div>
        <div class="sub">${t.start_date || '？'} ～ ${t.end_date || '？'}${t.note ? '｜' + esc(t.note) : ''}</div>
      </div>
      ${t.returned ? '<span class="badge mut">已歸還</span>'
        : `<button class="btn" onclick="event.stopPropagation();returnTrial(${t.id})">歸還</button>`}
      <button class="icon-btn" onclick="event.stopPropagation();delTrial(${t.id})">🗑</button>
    </div>`;
  };
  return `<h2 class="section">進行中（${act.length}）</h2>` +
    (act.map(item).join('') || '<div class="empty">無進行中的試用</div>') +
    (done.length ? `<h2 class="section">已歸還（${done.length}）</h2>` + done.map(item).join('') : '');
}
async function returnTrial(id) { await api(`/api/trial/${id}/return`, { method: 'POST' }); await load(); }

function openTrialEditForm(id) {
  const t = D.trials.find(x => x.id === id);
  if (!t) return;
  openModal(`<h2>編輯試用 / 出租</h2>
    <div class="field"><label>人名</label><input id="f_cust" list="custList" value="${esc(t.customer)}">
      <datalist id="custList">${D.customers.map(c => `<option value="${esc(c)}">`).join('')}</datalist></div>
    <div class="field"><label>型號</label><div class="seg" id="f_models"></div></div>
    <div class="two">
      <div class="field"><label>開始</label><input id="f_start" type="date" value="${t.start_date}"></div>
      <div class="field"><label>結束</label><input id="f_end" type="date" value="${t.end_date}"></div>
    </div>
    <div class="two">
      <div class="field"><label>狀態</label><div class="seg" id="f_tstatus"></div></div>
      <div class="field"><label>備註</label><input id="f_note" value="${esc(t.note)}"></div>
    </div>
    <div class="form-actions">
      <button class="btn" onclick="closeModal()">取消</button>
      <button class="btn primary" onclick="submitTrialEdit(${t.id})">儲存</button>
    </div>`);
  let model = t.model;
  let returned = !!t.returned;
  const renderModels = () => {
    $('#f_models').innerHTML = [...MODELS, ''].map(mo =>
      `<button class="${mo === model ? 'on' : ''}" data-m="${esc(mo)}">${mo ? esc(mo) : '未定'}</button>`).join('');
    $('#f_models').querySelectorAll('button').forEach(b => b.onclick = () => { model = b.dataset.m; renderModels(); });
  };
  const renderStatus = () => {
    $('#f_tstatus').innerHTML =
      `<button class="${returned ? '' : 'on'}" data-r="0">進行中</button>` +
      `<button class="${returned ? 'on' : ''}" data-r="1">已歸還</button>`;
    $('#f_tstatus').querySelectorAll('button').forEach(b => b.onclick = () => { returned = b.dataset.r === '1'; renderStatus(); });
  };
  renderModels(); renderStatus();
  window._teModel = () => model;
  window._teReturned = () => returned;
}
async function submitTrialEdit(id) {
  await api('/api/trial/' + id, {
    method: 'PATCH',
    body: {
      customer: $('#f_cust').value.trim(), model: window._teModel(),
      start_date: $('#f_start').value, end_date: $('#f_end').value,
      note: $('#f_note').value.trim(), returned: window._teReturned() ? 1 : 0
    }
  });
  closeModal(); await load();
}
async function delTrial(id) {
  if (!confirm('刪除此筆試用紀錄？')) return;
  await api('/api/trial/' + id, { method: 'DELETE' }); await load();
}
function openTrialForm() {
  const plus30 = new Date(Date.now() + 30 * 86400000).toLocaleDateString('sv-SE');
  openModal(`<h2>新增試用 / 出租</h2>
    <div class="field"><label>人名</label><input id="f_cust" list="custList" placeholder="客戶名">
      <datalist id="custList">${D.customers.map(c => `<option value="${esc(c)}">`).join('')}</datalist></div>
    <div class="field"><label>型號</label><div class="seg" id="f_models"></div></div>
    <div class="two">
      <div class="field"><label>開始</label><input id="f_start" type="date" value="${today()}"></div>
      <div class="field"><label>結束</label><input id="f_end" type="date" value="${plus30}"></div>
    </div>
    <div class="field"><label>備註（選填）</label><input id="f_note" placeholder="總部月租、自有機…"></div>
    <div class="form-actions">
      <button class="btn" onclick="closeModal()">取消</button>
      <button class="btn primary" onclick="submitTrial()">儲存</button>
    </div>`);
  let model = 'Standard';
  const renderModels = () => {
    $('#f_models').innerHTML = MODELS.map(mo =>
      `<button class="${mo === model ? 'on' : ''}" data-m="${esc(mo)}">${esc(mo)}</button>`).join('');
    $('#f_models').querySelectorAll('button').forEach(b => b.onclick = () => { model = b.dataset.m; renderModels(); });
  };
  renderModels();
  window._tModel = () => model;
}
async function submitTrial() {
  await api('/api/trial', {
    body: {
      customer: $('#f_cust').value.trim(), model: window._tModel(),
      start_date: $('#f_start').value, end_date: $('#f_end').value,
      note: $('#f_note').value.trim()
    }
  });
  closeModal(); await load();
}

/* ---------- stock ---------- */
let stockFilter = 'active';
function viewStock() {
  const counts = {};
  MODELS.forEach(mo => {
    counts[mo] = {
      stock: D.units.filter(u => u.model === mo && u.status === 'in_stock').length,
      trial: D.units.filter(u => u.model === mo && u.status === 'trial').length
    };
  });
  const chips = MODELS.filter(mo => counts[mo].stock + counts[mo].trial > 0 || D.units.some(u => u.model === mo)).map(mo =>
    `<div class="chip-card"><div class="num">${counts[mo].stock}</div>
     <div class="lbl">${esc(mo)}${counts[mo].trial ? `（＋試用 ${counts[mo].trial}）` : ''}</div></div>`).join('');
  const filters = [['active', '在庫＋試用'], ['sold', '已售'], ['all', '全部']].map(([k, l]) =>
    `<button class="${stockFilter === k ? 'on' : ''}" onclick="setStockFilter('${k}')">${l}</button>`).join('');
  const units = D.units.filter(u =>
    stockFilter === 'all' ? true :
    stockFilter === 'sold' ? u.status === 'sold' :
    (u.status === 'in_stock' || u.status === 'trial'));
  const badge = u => {
    const cls = { in_stock: 'ok', trial: 'warn', sold: 'mut', retired: 'bad' }[u.status];
    return `<span class="badge ${cls}">${STATUS_LABEL[u.status]}</span>`;
  };
  return `<div class="chips">${chips}</div>
    <div class="seg" style="margin-bottom:12px">${filters}</div>` +
    (units.map(u => `<div class="card row" onclick="openUnitForm(${u.id})" style="cursor:pointer">
      <div class="grow">
        <div class="title">${esc(u.serial)} <span class="badge">${esc(u.model)}</span> ${badge(u)}</div>
        <div class="sub">成本 ${fmt(u.cost)}${u.note ? '｜' + esc(u.note) : ''}</div>
      </div><div class="sub">✎</div>
    </div>`).join('') || '<div class="empty">無資料</div>');
}
function setStockFilter(k) { stockFilter = k; render(); }

function openUnitForm(id) {
  const u = D.units.find(x => x.id === id);
  if (!u) return;
  const editable = u.status !== 'sold';
  const statusOpts = (u.status === 'sold' ? ['sold'] : ['in_stock', 'trial', 'retired'])
    .map(s => `<option value="${s}" ${u.status === s ? 'selected' : ''}>${STATUS_LABEL[s]}</option>`).join('');
  openModal(`<h2>編輯機器</h2>
    <div class="field"><label>貨號</label><input id="f_serial" value="${esc(u.serial)}" ${editable ? '' : 'disabled'}></div>
    <div class="two">
      <div class="field"><label>成本</label><input id="f_cost" type="number" inputmode="numeric" value="${u.cost}" ${editable ? '' : 'disabled'}></div>
      <div class="field"><label>狀態</label><select id="f_status" ${editable ? '' : 'disabled'}>${statusOpts}</select></div>
    </div>
    <div class="field"><label>備註</label><input id="f_note" value="${esc(u.note)}"></div>
    <div class="form-actions">
      <button class="btn" onclick="closeModal()">取消</button>
      ${editable ? `<button class="btn primary" onclick="submitUnit(${u.id})">儲存</button>` : ''}
    </div>`);
}
async function submitUnit(id) {
  await api('/api/unit/' + id, {
    method: 'PATCH',
    body: {
      serial: $('#f_serial').value.trim(), cost: +$('#f_cost').value || 0,
      status: $('#f_status').value, note: $('#f_note').value.trim()
    }
  });
  closeModal(); await load();
}

/* ---------- report ---------- */
function viewReport() {
  if (!D.monthly.length) return '<div class="empty">尚無資料</div>';
  const rows = D.monthly;
  const tot = rows.reduce((a, r) => ({
    revenue: a.revenue + r.revenue, cost: a.cost + r.cost, profit: a.profit + r.profit, qty: a.qty + r.qty
  }), { revenue: 0, cost: 0, profit: 0, qty: 0 });
  const max = Math.max(...rows.map(r => r.revenue), 1);
  const W = 660, H = 200, bw = Math.min(44, (W - 40) / rows.length / 1.6);
  const bars = rows.map((r, i) => {
    const x = 30 + i * ((W - 40) / rows.length);
    const hr = r.revenue / max * (H - 30), hp = Math.max(0, r.profit) / max * (H - 30);
    return `<rect x="${x}" y="${H - 20 - hr}" width="${bw}" height="${hr}" rx="4" fill="#3b4a9f" opacity=".85"/>
      <rect x="${x + bw * .45}" y="${H - 20 - hp}" width="${bw * .55}" height="${hp}" rx="3" fill="#1a8f5c"/>
      <text x="${x + bw / 2}" y="${H - 5}" font-size="10" text-anchor="middle" fill="#6b7290">${r.ym.slice(5)}</text>`;
  }).join('');
  return `<div class="chart-card">
      <div class="legend"><span><span class="dot" style="background:#3b4a9f"></span>銷售</span>
      <span><span class="dot" style="background:#1a8f5c"></span>毛利</span></div>
      <svg viewBox="0 0 ${W} ${H}" style="width:100%">${bars}</svg>
    </div>
    <table>
      <tr><th>月份</th><th>銷售總額</th><th>成本</th><th>毛利</th><th>台數</th><th>毛利率</th></tr>
      ${rows.map(r => `<tr><td>${r.ym}</td><td>${fmt(r.revenue)}</td><td>${fmt(r.cost)}</td>
        <td class="${r.profit >= 0 ? 'pos' : 'neg'}">${fmt(r.profit)}</td><td>${r.qty}</td>
        <td>${r.revenue ? (r.profit / r.revenue * 100).toFixed(1) : '0.0'}%</td></tr>`).join('')}
      <tr class="total"><td>合計</td><td>${fmt(tot.revenue)}</td><td>${fmt(tot.cost)}</td>
        <td>${fmt(tot.profit)}</td><td>${tot.qty}</td>
        <td>${tot.revenue ? (tot.profit / tot.revenue * 100).toFixed(1) : '0.0'}%</td></tr>
    </table>`;
}

/* ---------- boot ---------- */
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
load().catch(() => showLogin());
