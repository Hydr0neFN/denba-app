'use strict';
const $ = s => document.querySelector(s);
const MODELS = ['High Grade', 'Standard', 'Charge', 'Pet'];
const PREFIX = { 'High Grade': 'HG', 'Standard': 'ST', 'Charge': 'CH', 'Pet': 'PT' };
const STATUS_LABEL = { in_stock: '在庫', sold: '已售', trial: '試用機', retired: '除役', consigned: '特許機' };
const WITHHOLD_RATE = 0.10, HEALTH_RATE = 0.0211;
const DEFAULT_COMM_PCT = 30, MIN_COMM_PCT = 12.11;   // 保證金% + 佣金% = 100；稅+補充保費從佣金預扣，故佣金下限 12.11%
const halfUp = x => Math.round(x);   // Math.round is half-up for positives — fine here
const franchiseCalc = (price, deposit) => {
  const commission = price - deposit;
  const tax = halfUp(commission * WITHHOLD_RATE);
  const health = halfUp(commission * HEALTH_RATE);
  return { commission, tax, health, net: commission - tax - health };
};
const nextMonth15 = d => {
  const [y, m] = d.split('-').map(Number);
  return m === 12 ? `${y + 1}-01-15` : `${y}-${String(m + 1).padStart(2, '0')}-15`;
};
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
  $('#whoami').textContent = D.me.username + (D.me.is_admin ? '｜管理員' : '');
  hideLogin();
  render();
}

/* ---------- login ---------- */
function showLogin() {
  $('#login').classList.remove('hidden');
  ['#topbar', '#main', '#tabs', '#fab'].forEach(s => $(s).classList.add('hidden'));
  setTimeout(() => ($('#lu').value ? $('#pw') : $('#lu')).focus(), 50);
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
      body: JSON.stringify({ username: $('#lu').value.trim(), password: $('#pw').value })
    });
    if (!r.ok) { $('#loginMsg').textContent = '帳號或密碼錯誤'; return; }
    $('#pw').value = '';
    await load();
  } catch { $('#loginMsg').textContent = '無法連線'; }
}
$('#loginForm').addEventListener('submit', e => { e.preventDefault(); doLogin(); });
$('#lu').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); $('#pw').focus(); }
});
$('#logoutBtn').onclick = async () => { await fetch('/api/logout', { method: 'POST' }); showLogin(); };

/* ---------- advanced settings ---------- */
$('#settingsBtn').onclick = () => openSettings();
async function openSettings() {
  const j = await api('/api/backups');
  const isAdmin = D.me.is_admin;
  const fmtU = n => {
    const m = n.match(/^user\d+-(?:(pre-restore|pre-delete)-)?(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})\d{2}\.json$/);
    if (!m) return n;
    const tag = m[1] === 'pre-restore' ? '還原前自動備份' : m[1] === 'pre-delete' ? '刪除前自動備份' : '手動備份';
    return `${m[2]}-${m[3]}-${m[4]} ${m[5]}:${m[6]}　${tag}`;
  };
  const fmtS = n => {
    let m = n.match(/^denba-(\d{4})(\d{2})(\d{2})\.db$/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}　每日系統備份`;
    m = n.match(/^denba-pre-restore-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})\d{2}\.db$/);
    if (m) return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}　系統還原前備份`;
    return n;
  };
  openModal(`<h2>⚙️ 進階設定</h2>
    <h2 class="section" style="margin-top:0">帳戶</h2>
    <div class="card row">
      <div class="grow">
        <div class="title">${esc(D.me.username)}</div>
        <div class="sub">${isAdmin ? '管理員' : '一般使用者'}</div>
      </div>
      <button class="btn" onclick="openChangePw()">修改密碼</button>
    </div>
    <h2 class="section">我的資料備份（只影響自己的資料）</h2>
    <div class="form-actions" style="margin:0 0 10px">
      <button class="btn primary" onclick="backupNow()">📸 立即備份</button>
    </div>
    ${j.user_backups.map(b => `<div class="card row">
      <div class="grow">
        <div class="title" style="font-size:15px">${fmtU(b.name)}</div>
        <div class="sub">${b.name}｜${Math.round(b.size / 1024)} KB</div>
      </div>
      <button class="btn danger" onclick="restoreBackup('${b.name}')">還原</button>
    </div>`).join('') || '<div class="empty" style="padding:14px 0">尚無備份</div>'}
    ${isAdmin ? `
    <h2 class="section">系統備份（整個資料庫，影響所有使用者）</h2>
    ${j.system_backups.map(b => `<div class="card row">
      <div class="grow">
        <div class="title" style="font-size:15px">${fmtS(b.name)}</div>
        <div class="sub">${b.name}｜${Math.round(b.size / 1024)} KB</div>
      </div>
      <button class="btn danger" onclick="restoreBackup('${b.name}')">全系統還原</button>
    </div>`).join('') || '<div class="empty" style="padding:14px 0">尚無系統備份</div>'}
    <h2 class="section">使用者管理</h2>
    <div id="userAdmin"></div>` : ''}
    <div class="form-actions"><button class="btn" onclick="closeModal()">關閉</button></div>`);
  if (isAdmin) renderUserAdmin();
}
async function backupNow() {
  const j = await api('/api/backup-now', { method: 'POST', body: {} });
  alert('已備份：' + j.name);
  openSettings();
}
async function restoreBackup(name) {
  const sys = name.endsWith('.db');
  const msg = sys
    ? `【全系統還原】用「${name}」覆蓋整個資料庫？\n\n所有使用者的資料都會回到該時間點！\n目前狀態會先自動保存，可再還原回來。`
    : `用「${name}」還原自己的資料？\n\n只影響你自己的紀錄，其他使用者不受影響。\n目前資料會先自動保存，可再還原回來。`;
  if (!confirm(msg)) return;
  const j = await api('/api/restore', { method: 'POST', body: { name } });
  alert('已還原完成。\n原本的資料已保存為：' + j.pre_restore);
  closeModal();
  await load();
}
function openChangePw() {
  openModal(`<h2>修改密碼</h2>
    <div class="field"><label>目前密碼</label><input id="cp_old" type="password"></div>
    <div class="field"><label>新密碼（至少 8 碼）</label><input id="cp_new" type="password"></div>
    <div class="form-actions">
      <button class="btn" onclick="openSettings()">返回</button>
      <button class="btn primary" onclick="submitChangePw()">儲存</button>
    </div>`);
}
async function submitChangePw() {
  await api('/api/me/password', { body: { old: $('#cp_old').value, new: $('#cp_new').value } });
  alert('密碼已更新');
  openSettings();
}

/* ---------- user management (admin) ---------- */
async function renderUserAdmin() {
  const j = await api('/api/users');
  $('#userAdmin').innerHTML = j.users.map(u => `<div class="card row">
      <div class="grow">
        <div class="title">${esc(u.username)} ${u.is_admin ? '<span class="badge">管理員</span>' : '<span class="badge mut">一般</span>'}</div>
        <div class="sub">銷售 ${u.counts.sales}｜機器 ${u.counts.units}｜進貨 ${u.counts.purchases}｜試用 ${u.counts.trials}</div>
      </div>
      <button class="icon-btn" title="重設密碼" onclick="resetUserPw(${u.id},'${esc(u.username)}')">🔑</button>
      <button class="icon-btn" title="${u.is_admin ? '降為一般' : '升為管理員'}" onclick="toggleAdmin(${u.id},'${esc(u.username)}',${u.is_admin})">${u.is_admin ? '⬇️' : '⬆️'}</button>
      <button class="icon-btn" onclick="deleteUser(${u.id},'${esc(u.username)}')">🗑</button>
    </div>`).join('') + `
    <div class="card">
      <div class="two">
        <div class="field"><label>新帳號</label><input id="nu_name" autocapitalize="none" spellcheck="false" placeholder="英數字 2–20 位"></div>
        <div class="field"><label>密碼</label><input id="nu_pw" placeholder="至少 8 碼"></div>
      </div>
      <div class="field"><div class="seg" id="nu_role">
        <button class="on" data-r="0">一般使用者</button><button data-r="1">管理員</button>
      </div></div>
      <button class="btn primary" style="width:100%" onclick="createUser()">➕ 新增使用者</button>
    </div>`;
  window._nuRole = 0;
  $('#nu_role').querySelectorAll('button').forEach(b => b.onclick = () => {
    window._nuRole = +b.dataset.r;
    $('#nu_role').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
  });
}
async function createUser() {
  await api('/api/users', {
    body: { username: $('#nu_name').value.trim(), password: $('#nu_pw').value, is_admin: window._nuRole }
  });
  renderUserAdmin();
}
async function resetUserPw(id, name) {
  const pw = prompt(`為「${name}」設定新密碼（至少 8 碼）：`);
  if (!pw) return;
  await api('/api/users/' + id, { method: 'PATCH', body: { password: pw } });
  alert('已重設密碼');
}
async function toggleAdmin(id, name, isAdmin) {
  if (!confirm(`${isAdmin ? '取消' : '賦予'}「${name}」的管理員權限？`)) return;
  await api('/api/users/' + id, { method: 'PATCH', body: { is_admin: isAdmin ? 0 : 1 } });
  renderUserAdmin();
}
async function deleteUser(id, name) {
  if (!confirm(`刪除使用者「${name}」及其全部資料？\n\n（該使用者的資料會先自動保存一份備份檔）`)) return;
  await api('/api/users/' + id, { method: 'DELETE' });
  renderUserAdmin();
}

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
    <button class="btn big" onclick="closeModal();openConsignForm()">🤝 特許領機</button>
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
  const unsettled = D.sales.filter(s => s.sale_type === 'franchise' && (s.deposit > 0 || s.commission > 0) && !s.settled);
  const banner = unsettled.length ? `<div class="card row">
      <div class="grow">
        <div class="title">🔔 居間特許未結清 ${unsettled.length} 筆</div>
        <div class="sub">應付合計 ${fmt(unsettled.reduce((a, s) => a + s.deposit + s.commission - s.tax - s.health_fee, 0))}</div>
      </div>
    </div>` : '';
  const agentOwingHtml = (D.agent_owing && D.agent_owing.length) ? `<h2 class="section">特許人應付對帳（未結清）</h2>` +
    D.agent_owing.map((a, i) => `<div class="card row">
      <div class="grow">
        <div class="title">${esc(a.agent)}</div>
        <div class="sub">${a.n} 筆｜退保證金 ${fmt(a.deposit)}＋實付佣金 ${fmt(a.net_comm)}＝應付 ${fmt(a.payable)}</div>
      </div>
      <button class="btn primary" onclick="settleAgentIdx(${i})">全部結清</button>
    </div>`).join('') : '';
  const consigns = (D.consignments || []).filter(c => !c.returned);
  const consignHtml = consigns.length ? `<h2 class="section">特許持機中（${consigns.length}）</h2>` +
    consigns.map(c => `<div class="card row" onclick="openConsignEditForm(${c.id})" style="cursor:pointer">
      <div class="grow">
        <div class="title">${esc(c.agent)} ${c.model ? `<span class="badge">${esc(c.model)}</span>` : ''} <span class="badge warn">特許機</span></div>
        <div class="sub">${c.serial ? esc(c.serial) + '｜' : ''}保證金 ${fmt(c.deposit)}（${c.deposit_date.slice(5)} 暫收）${c.note ? '｜' + esc(c.note) : ''}</div>
      </div>
      <button class="btn" onclick="event.stopPropagation();returnConsign(${c.id})">退回</button>
      <button class="btn primary" onclick="event.stopPropagation();openSaleFormFromConsign(${c.id})">售出</button>
      <button class="icon-btn" onclick="event.stopPropagation();delConsign(${c.id})">🗑</button>
    </div>`).join('') : '';
  if (!D.sales.length && !consignHtml && !banner && !agentOwingHtml) return '<div class="empty">尚無銷售紀錄，按＋新增</div>';
  const byMonth = {};
  D.sales.forEach(s => { (byMonth[s.date.slice(0, 7)] = byMonth[s.date.slice(0, 7)] || []).push(s); });
  return banner + agentOwingHtml + consignHtml + Object.keys(byMonth).sort().reverse().map(ym => {
    const rows = byMonth[ym];
    const rev = rows.reduce((a, s) => a + s.price - s.card_fee, 0);
    const profit = rows.reduce((a, s) => a + s.price - s.card_fee - s.cost - (s.commission || 0) - (s.extra_fee || 0), 0);
    return `<h2 class="section">${ym}　銷售 ${fmt(rev)}｜毛利 ${fmt(profit)}｜${rows.length} 台</h2>` +
      rows.map(s => {
        const p = s.price - s.card_fee - s.cost - (s.commission || 0) - (s.extra_fee || 0);
        const isFr = s.sale_type === 'franchise';
        const moneyRow = isFr && (s.deposit > 0 || s.commission > 0);
        return `<div class="card row" onclick="openSaleEditForm(${s.id})" style="cursor:pointer">
          <div class="grow">
            <div class="title">${esc(s.customer)} <span class="badge">${esc(s.model)}</span>${isFr ? ' <span class="badge">居間特許</span>' : ''}</div>
            <div class="sub">${s.date}${isFr ? '｜特許人 ' + esc(s.agent) : ''}${s.serial ? '｜' + esc(s.serial) : ''}${s.warranty_no ? '｜保固 ' + esc(s.warranty_no) : ''}${s.card_fee ? '｜刷卡費 ' + fmt(s.card_fee) : ''}${s.extra_fee ? '｜' + esc(s.extra_label || '其他費用') + ' ' + fmt(s.extra_fee) : ''}${s.note ? '｜' + esc(s.note) : ''}</div>
            ${moneyRow ? `<div class="sub">保證金 ${fmt(s.deposit)}（${s.deposit_date.slice(5)} 暫收）｜佣金 ${fmt(s.commission)}（稅 ${fmt(s.tax)}｜補 ${fmt(s.health_fee)}｜實付 ${fmt(s.commission - s.tax - s.health_fee)}）${!s.settled && s.settle_date ? `｜預計 ${s.settle_date.slice(5)} 結清` : ''}</div>` : ''}
          </div>
          <div class="amount">${fmt(s.price - s.card_fee)}<div class="sub ${p >= 0 ? 'pos' : 'neg'}">毛利 ${fmt(p)}</div></div>
          ${moneyRow ? `<span class="badge ${s.settled ? 'mut' : 'warn'}">${s.settled ? '已結清' : '未結清'}</span>` : ''}
          ${moneyRow && !s.settled ? `<button class="btn" onclick="event.stopPropagation();settleSale(${s.id})">結清</button>` : ''}
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
async function settleSale(id) {
  const s = D.sales.find(x => x.id === id);
  if (!s) return;
  const netComm = s.commission - s.tax - s.health_fee;
  const payout = s.deposit + netComm;
  const d = s.settle_date || today();
  if (!confirm(`結清此筆？結清日期 ${d}（可於編輯表單修改）\n退保證金 ${fmt(s.deposit)}＋實付佣金 ${fmt(netComm)}＝${fmt(payout)}`)) return;
  await api('/api/sale/' + id, { method: 'PATCH', body: { settled: 1, settle_date: d } });
  await load();
}
async function settleAgentIdx(idx) {
  const a = D.agent_owing[idx];
  if (!a) return;
  const agent = a.agent;
  if (!confirm(agent + ' 的所有未結清居間特許一次結清（記為今日結清日）？')) return;
  const j = await api('/api/settle-agent', { body: { agent } });
  alert('已結清 ' + j.count + ' 筆');
  await load();
}

function openSaleEditForm(id) {
  const s = D.sales.find(x => x.id === id);
  if (!s) return;
  const isFr0 = s.sale_type === 'franchise';
  // initial franchise-field values: the row's own when already franchise,
  // computed defaults when the owner later toggles a normal sale over
  const dep0 = isFr0 ? s.deposit : halfUp(s.price * (100 - DEFAULT_COMM_PCT) / 100);
  const calc0 = franchiseCalc(s.price, dep0);
  const comm0 = isFr0 ? s.commission : calc0.commission;
  const tax0 = isFr0 ? s.tax : calc0.tax;
  const health0 = isFr0 ? s.health_fee : calc0.health;
  const pct0 = s.price > 0 ? +((comm0 / s.price) * 100).toFixed(2) : DEFAULT_COMM_PCT;
  const depdate0 = (isFr0 && s.deposit_date) ? s.deposit_date : s.date;
  const setdate0 = (isFr0 && s.settle_date) ? s.settle_date : nextMonth15(s.date);
  openModal(`<h2>編輯銷售</h2>
    <div class="field"><label>類別</label><div class="seg" id="f_saletype">
      <button class="${isFr0 ? '' : 'on'}" data-t="normal">一般銷售</button><button class="${isFr0 ? 'on' : ''}" data-t="franchise">居間特許</button>
    </div></div>
    <div id="f_head"></div>
    <div class="field"><label>型號</label><div class="seg" id="f_models"></div></div>
    <div class="two">
      <div class="field"><label>貨號${s.unit_id ? '（同步更新機器）' : ''}</label><input id="f_serial" value="${esc(s.serial)}"></div>
      <div class="field"><label>保證書編號</label><input id="f_warranty" value="${esc(s.warranty_no || '')}"></div>
    </div>
    <div class="two">
      <div class="field"><label>銷售單價（此筆單台）</label><input id="f_price" type="text" inputmode="numeric" value="${s.price}"></div>
      <div class="field"><label>刷卡手續費</label><input id="f_fee" type="text" inputmode="numeric" value="${s.card_fee}"></div>
    </div>
    <div class="two">
      <div class="field"><label>進貨成本</label><input id="f_cost" type="text" inputmode="numeric" value="${s.cost}"></div>
      <div class="field"><label>備註</label><input id="f_note" value="${esc(s.note)}"></div>
    </div>
    <div class="two">
      <div class="field"><label>其他費用（選填）</label><input id="f_extra" type="text" inputmode="numeric" value="${s.extra_fee || ''}" placeholder="0"></div>
      <div class="field"><label>費用名稱（選填）</label><input id="f_extralbl" value="${esc(s.extra_label || '')}" placeholder="調貨、開發票…"></div>
    </div>
    <div class="${isFr0 ? '' : 'hidden'}" id="f_franwrap">
      <h2 class="section">居間特許</h2>
      <div class="two">
        <div class="field"><label>保證金</label><input id="f_deposit" type="text" inputmode="numeric" value="${dep0}"></div>
        <div class="field"><label>佣金比例％（下限 ${MIN_COMM_PCT}）</label><input id="f_pct" type="number" inputmode="decimal" step="0.01" min="${MIN_COMM_PCT}" max="100" value="${pct0}"></div>
      </div>
      <div class="three">
        <div class="field"><label>佣金</label><input id="f_comm" class="calc" type="text" inputmode="numeric" value="${comm0}"></div>
        <div class="field"><label>預扣稅款（10%）</label><input id="f_tax" class="calc" type="text" inputmode="numeric" value="${tax0}"></div>
        <div class="field"><label>補充保費（2.11%）</label><input id="f_health" class="calc" type="text" inputmode="numeric" value="${health0}"></div>
      </div>
      <div class="field"><label>結清狀態</label><div class="seg" id="f_settled">
        <button class="${(isFr0 && s.settled) ? '' : 'on'}" data-s="0">未結清</button><button class="${(isFr0 && s.settled) ? 'on' : ''}" data-s="1">已結清</button>
      </div></div>
    </div>
    <div class="preview" id="f_preview"></div>
    <div class="form-actions">
      <button class="btn" onclick="closeModal()">取消</button>
      <button class="btn primary" onclick="submitSaleEdit(${s.id})">儲存</button>
    </div>`);
  let model = s.model;
  let settled = isFr0 ? s.settled : 0;
  let saleType = s.sale_type;
  const headVals = { date: s.date, cust: s.customer, agent: s.agent, depdate: depdate0, setdate: setdate0 };
  const grab = () => {
    ['date', 'cust', 'agent', 'depdate', 'setdate'].forEach(k => {
      const el = $('#f_' + k);
      if (el) headVals[k] = el.value;
    });
  };
  const renderHead = () => {
    const custIn = `<div class="field"><label>客戶</label><input id="f_cust" list="custList" value="${esc(headVals.cust)}">
        <datalist id="custList">${D.customers.map(c => `<option value="${esc(c)}">`).join('')}</datalist></div>`;
    $('#f_head').innerHTML = saleType === 'franchise'
      ? `<div class="two">
          ${custIn}
          <div class="field"><label>特許人</label><input id="f_agent" list="agentList" value="${esc(headVals.agent)}">
            <datalist id="agentList">${D.agents.map(a => `<option value="${esc(a)}">`).join('')}</datalist></div>
        </div>
        <div class="three">
          <div class="field"><label>① 保證金收款日</label><input id="f_depdate" type="date" value="${headVals.depdate}"></div>
          <div class="field"><label>② 售出日期</label><input id="f_date" type="date" value="${headVals.date}"></div>
          <div class="field"><label>③ 結清日期</label><input id="f_setdate" type="date" value="${headVals.setdate}"></div>
        </div>`
      : `<div class="two">
          <div class="field"><label>日期</label><input id="f_date" type="date" value="${headVals.date}"></div>
          ${custIn}
        </div>`;
    $('#f_date').oninput = () => { grab(); preview(); };
    $('#f_cust').oninput = grab;
    if (saleType === 'franchise') {
      $('#f_agent').oninput = grab;
      $('#f_depdate').oninput = grab;
      $('#f_setdate').oninput = grab;
    }
  };
  const renderModels = () => {
    $('#f_models').innerHTML = MODELS.map(mo =>
      `<button class="${mo === model ? 'on' : ''}" data-m="${esc(mo)}">${esc(mo)}</button>`).join('');
    $('#f_models').querySelectorAll('button').forEach(b => b.onclick = () => { model = b.dataset.m; renderModels(); });
  };
  const preview = () => {
    const price = +$('#f_price').value || 0, fee = +$('#f_fee').value || 0, cost = +$('#f_cost').value || 0;
    const rev = price - fee;
    const extra = +$('#f_extra').value || 0;
    const extraTxt = extra ? `｜${esc($('#f_extralbl').value.trim() || '其他費用')} −${fmt(extra)}` : '';
    if (saleType === 'franchise') {
      const commission = +$('#f_comm').value || 0;
      const netComm = commission - (+$('#f_tax').value || 0) - (+$('#f_health').value || 0);
      const p = rev - cost - commission - extra;
      const pctLow = price > 0 && commission * 10000 < price * 1211;
      $('#f_preview').innerHTML =
        `實收 <b>${fmt(rev)}</b>｜成本 ${fmt(cost)}｜佣金 ${fmt(commission)}｜實付佣金 ${fmt(netComm)}${extraTxt}｜毛利 <b class="${p >= 0 ? 'pos' : 'neg'}">${fmt(p)}</b>` +
        (pctLow ? `<br><b class="neg">佣金比例不可低於 ${MIN_COMM_PCT}%</b>` : '');
    } else {
      const p = rev - cost - extra;
      $('#f_preview').innerHTML =
        `實收 <b>${fmt(rev)}</b>｜成本 ${fmt(cost)}${extraTxt}｜毛利 <b class="${p >= 0 ? 'pos' : 'neg'}">${fmt(p)}</b>`;
    }
  };
  const syncPct = () => {
    const price = +$('#f_price').value || 0, comm = +$('#f_comm').value || 0;
    if (price > 0) $('#f_pct').value = +((comm / price) * 100).toFixed(2);
  };
  const fillTaxHealth = () => {
    const comm = +$('#f_comm').value || 0;
    $('#f_tax').value = halfUp(comm * WITHHOLD_RATE);
    $('#f_health').value = halfUp(comm * HEALTH_RATE);
  };
  const recompute = () => {
    const price = +$('#f_price').value || 0, deposit = +$('#f_deposit').value || 0;
    $('#f_comm').value = price - deposit;
    syncPct(); fillTaxHealth(); preview();
  };
  const recalcFromPct = () => {
    const price = +$('#f_price').value || 0;
    const pct = Math.min(100, Math.max(0, +$('#f_pct').value || 0));
    const deposit = halfUp(price * (100 - pct) / 100);
    $('#f_deposit').value = deposit;
    $('#f_comm').value = price - deposit;
    fillTaxHealth(); preview();
  };
  $('#f_saletype').querySelectorAll('button').forEach(b => b.onclick = () => {
    saleType = b.dataset.t;
    $('#f_saletype').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    $('#f_franwrap').classList.toggle('hidden', saleType !== 'franchise');
    grab(); renderHead();
    preview();
  });
  $('#f_price').oninput = () => { saleType === 'franchise' ? recompute() : preview(); };
  $('#f_deposit').oninput = recompute;
  $('#f_pct').oninput = recalcFromPct;
  $('#f_pct').onblur = () => {
    const val = $('#f_pct').value;
    if (val !== '' && +val < MIN_COMM_PCT) {
      $('#f_pct').value = MIN_COMM_PCT;
      recalcFromPct();
    }
  };
  $('#f_comm').oninput = () => {
    const price = +$('#f_price').value || 0;
    $('#f_deposit').value = price - (+$('#f_comm').value || 0);
    syncPct(); fillTaxHealth(); preview();
  };
  ['#f_fee', '#f_cost', '#f_tax', '#f_health', '#f_extra', '#f_extralbl'].forEach(sel => $(sel).oninput = preview);
  $('#f_settled').querySelectorAll('button').forEach(b => b.onclick = () => {
    settled = +b.dataset.s;
    $('#f_settled').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
  });
  renderHead(); renderModels(); preview();
  window._seModel = () => model;
  window._seType = () => saleType;
  window._seSettled = () => settled;
}
async function submitSaleEdit(id) {
  const body = {
    date: $('#f_date').value, customer: $('#f_cust').value.trim(),
    model: window._seModel(), serial: $('#f_serial').value.trim(),
    price: +$('#f_price').value || 0, card_fee: +$('#f_fee').value || 0,
    cost: +$('#f_cost').value || 0, warranty_no: $('#f_warranty').value.trim(),
    note: $('#f_note').value.trim(),
    extra_fee: +$('#f_extra').value || 0, extra_label: $('#f_extralbl').value.trim()
  };
  body.sale_type = window._seType();
  if (body.sale_type === 'franchise') {
    body.agent = $('#f_agent').value.trim();
    body.deposit_date = $('#f_depdate').value;
    body.deposit = +$('#f_deposit').value || 0;
    body.commission = +$('#f_comm').value || 0;
    body.tax = +$('#f_tax').value || 0;
    body.health_fee = +$('#f_health').value || 0;
    body.settled = window._seSettled();
    body.settle_date = $('#f_setdate').value;
  }
  await api('/api/sale/' + id, { method: 'PATCH', body });
  closeModal(); await load();
}

function openSaleForm(opts = {}) {
  const avail = D.units.filter(u => u.status === 'in_stock' || u.status === 'consigned');
  if (!avail.length) { alert('目前沒有在庫機器，請先登記進貨'); return; }
  const consignByUnit = {};
  (D.consignments || []).forEach(c => { if (c.unit_id) consignByUnit[c.unit_id] = c; });
  openModal(`<h2>新增銷售</h2>
    <div class="field"><label>類別</label><div class="seg" id="f_saletype">
      <button class="on" data-t="normal">一般銷售</button><button data-t="franchise">居間特許</button>
    </div></div>
    <div id="f_head"></div>
    <div class="field"><label>型號</label><div class="seg" id="f_models"></div></div>
    <div class="field"><label>貨號（可多選）</label><div class="unit-chips" id="f_units"></div></div>
    <div class="field hidden" id="f_fixwrap"><label>貨號確認／更正（賣出時填實際貨號）</label><div id="f_fixes"></div></div>
    <div class="two">
      <div class="field"><label id="f_price_lbl">銷售單價</label><input id="f_price" type="text" inputmode="numeric" placeholder="0"></div>
      <div class="field"><label>刷卡手續費（選填）</label><input id="f_fee" type="text" inputmode="numeric" placeholder="0"></div>
    </div>
    <div class="hidden" id="f_franwrap">
      <div class="two">
        <div class="field"><label>保證金（自動＝售價×保證金%）</label><input id="f_deposit" type="text" inputmode="numeric" placeholder="0"></div>
        <div class="field"><label>佣金比例％（下限 ${MIN_COMM_PCT}）</label><input id="f_pct" type="number" inputmode="decimal" step="0.01" min="${MIN_COMM_PCT}" max="100" value="${DEFAULT_COMM_PCT}"></div>
      </div>
      <div class="three">
        <div class="field"><label>佣金</label><input id="f_comm" class="calc" type="text" inputmode="numeric" placeholder="0"></div>
        <div class="field"><label>預扣稅款（10%）</label><input id="f_tax" class="calc" type="text" inputmode="numeric" placeholder="0"></div>
        <div class="field"><label>補充保費（2.11%）</label><input id="f_health" class="calc" type="text" inputmode="numeric" placeholder="0"></div>
      </div>
    </div>
    <div class="two">
      <div class="field"><label>其他費用（選填）</label><input id="f_extra" type="text" inputmode="numeric" placeholder="0"></div>
      <div class="field"><label>費用名稱（選填）</label><input id="f_extralbl" placeholder="調貨、開發票…"></div>
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
  let saleType = 'normal';
  // 'pct': price drives 保證金 via 佣金比例; 'amount': 保證金 fixed (consign prefill or hand-set)
  let depositMode = 'pct';
  let setdateTouched = false;
  // shared header inputs survive the normal↔franchise re-render via this store
  const headVals = { date: today(), cust: '', agent: '', depdate: today(), setdate: '' };
  const grab = () => {
    ['date', 'cust', 'agent', 'depdate', 'setdate'].forEach(k => {
      const el = $('#f_' + k);
      if (el) headVals[k] = el.value;
    });
  };
  const renderHead = () => {
    const custIn = `<div class="field"><label>客戶</label><input id="f_cust" list="custList" placeholder="人名" value="${esc(headVals.cust)}">
        <datalist id="custList">${D.customers.map(c => `<option value="${esc(c)}">`).join('')}</datalist></div>`;
    $('#f_head').innerHTML = saleType === 'franchise'
      ? `<div class="two">
          ${custIn}
          <div class="field"><label>特許人</label><input id="f_agent" list="agentList" placeholder="姓名" value="${esc(headVals.agent)}">
            <datalist id="agentList">${D.agents.map(a => `<option value="${esc(a)}">`).join('')}</datalist></div>
        </div>
        <div class="three">
          <div class="field"><label>① 保證金收款日</label><input id="f_depdate" type="date" value="${headVals.depdate}"></div>
          <div class="field"><label>② 售出日期</label><input id="f_date" type="date" value="${headVals.date}"></div>
          <div class="field"><label>③ 預計結清日</label><input id="f_setdate" type="date" value="${headVals.setdate || (headVals.date ? nextMonth15(headVals.date) : '')}"></div>
        </div>`
      : `<div class="two">
          <div class="field"><label>日期</label><input id="f_date" type="date" value="${headVals.date}"></div>
          ${custIn}
        </div>`;
    $('#f_date').oninput = () => {
      if (saleType === 'franchise' && !setdateTouched) {
        $('#f_setdate').value = $('#f_date').value ? nextMonth15($('#f_date').value) : '';
      }
      grab(); preview();
    };
    $('#f_cust').oninput = grab;
    if (saleType === 'franchise') {
      $('#f_agent').oninput = grab;
      $('#f_depdate').oninput = () => { grab(); preview(); };
      $('#f_setdate').oninput = () => { setdateTouched = $('#f_setdate').value !== ''; grab(); preview(); };
    }
  };
  const pctVal = () => Math.min(100, Math.max(0, +$('#f_pct').value || 0));
  const syncPct = () => {
    const price = +$('#f_price').value || 0, comm = +$('#f_comm').value || 0;
    if (price > 0) $('#f_pct').value = +((comm / price) * 100).toFixed(2);
  };
  const fillTaxHealth = () => {
    const comm = +$('#f_comm').value || 0;
    $('#f_tax').value = halfUp(comm * WITHHOLD_RATE);
    $('#f_health').value = halfUp(comm * HEALTH_RATE);
  };
  const recalcFromPct = () => {
    const price = +$('#f_price').value || 0;
    if (!price) { ['#f_deposit', '#f_comm', '#f_tax', '#f_health'].forEach(x => $(x).value = ''); preview(); return; }
    const deposit = halfUp(price * (100 - pctVal()) / 100);
    $('#f_deposit').value = deposit;
    $('#f_comm').value = price - deposit;
    fillTaxHealth(); preview();
  };
  const recalcFromDeposit = () => {
    const price = +$('#f_price').value || 0;
    if (!price) { ['#f_comm', '#f_tax', '#f_health'].forEach(x => $(x).value = ''); preview(); return; }
    $('#f_comm').value = price - (+$('#f_deposit').value || 0);
    syncPct(); fillTaxHealth(); preview();
  };
  $('#f_saletype').querySelectorAll('button').forEach(b => b.onclick = () => {
    saleType = b.dataset.t;
    $('#f_saletype').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    $('#f_franwrap').classList.toggle('hidden', saleType !== 'franchise');
    grab(); renderHead();
    if (saleType !== 'franchise') [...sel].forEach(id => { if (consignByUnit[id]) sel.delete(id); });
    else depositMode === 'pct' ? recalcFromPct() : recalcFromDeposit();
    renderUnits(); renderFixes();
    preview();
  });
  $('#f_pct').oninput = () => { depositMode = 'pct'; recalcFromPct(); };
  $('#f_pct').onblur = () => {
    const val = $('#f_pct').value;
    if (val !== '' && +val < MIN_COMM_PCT) {
      $('#f_pct').value = MIN_COMM_PCT;
      depositMode = 'pct';
      recalcFromPct();
    }
  };
  $('#f_deposit').oninput = () => { depositMode = 'amount'; recalcFromDeposit(); };
  $('#f_comm').oninput = () => {
    depositMode = 'amount';
    const price = +$('#f_price').value || 0;
    $('#f_deposit').value = price - (+$('#f_comm').value || 0);
    syncPct(); fillTaxHealth(); preview();
  };
  $('#f_tax').oninput = () => preview(); $('#f_health').oninput = () => preview();
  $('#f_extra').oninput = () => preview(); $('#f_extralbl').oninput = () => preview();
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
    $('#f_units').innerHTML = avail.filter(u => model === 'ALL' || u.model === model).map(u => {
      const cg = consignByUnit[u.id];
      const dis = cg && saleType !== 'franchise';
      return `<button ${dis ? 'disabled' : ''} class="${sel.has(u.id) ? 'on' : ''}" data-id="${u.id}">${esc(u.serial)}<span class="c">${cg ? '特許｜' + esc(cg.agent) + '｜' : ''}${model === 'ALL' ? esc(u.model) + '｜' : ''}成本 ${fmt(u.cost)}</span></button>`;
    }).join('');
    $('#f_units').querySelectorAll('button').forEach(b => b.onclick = () => {
      const id = +b.dataset.id;
      sel.has(id) ? sel.delete(id) : sel.add(id);
      if (saleType === 'franchise') prefillFromConsigns();
      renderUnits(); renderFixes(); preview();
    });
  };
  const prefillFromConsigns = () => {
    const cs = [...sel].map(id => consignByUnit[id]).filter(Boolean);
    if (!cs.length) return;
    $('#f_agent').value = cs[0].agent;
    $('#f_deposit').value = cs.reduce((a, c) => a + c.deposit, 0);
    $('#f_depdate').value = cs.map(c => c.deposit_date).filter(Boolean).sort()[0] || today();
    depositMode = 'amount';   // the consignment's deposit is real money — price input must not overwrite it
    recalcFromDeposit();
    grab();
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
    if (!n) { $('#f_preview').innerHTML = '請選擇貨號'; return; }
    const extra = +$('#f_extra').value || 0;
    const extraTxt = extra ? `｜${esc($('#f_extralbl').value.trim() || '其他費用')} −${fmt(extra)}` : '';
    if (saleType === 'franchise') {
      const deposit = +$('#f_deposit').value || 0, commission = +$('#f_comm').value || 0;
      const tax = +$('#f_tax').value || 0, health = +$('#f_health').value || 0;
      const net = commission - tax - health;
      const gp = rev - cost - commission - extra;
      const pctLow = total > 0 && commission * 10000 < total * 1211;
      const sellDate = $('#f_date').value, depDate = $('#f_depdate').value, setDate = $('#f_setdate').value;
      $('#f_preview').innerHTML =
        `收入：保證金 ${fmt(deposit)}（${depDate.slice(5)} 暫收）｜售價 ${fmt(rev)}（${sellDate.slice(5)} 售出）<br>` +
        `支付（預計 ${setDate || '—'} 結清）：退保證金 ${fmt(deposit)}｜佣金 ${fmt(commission)}<br>` +
        `　佣金明細：預扣稅款 −${fmt(tax)}｜補充保費 −${fmt(health)}｜實付佣金 ${fmt(net)}<br>` +
        `本筆毛利（實收−成本−佣金${extra ? '−其他費用' : ''}）${extraTxt}：<b class="${gp >= 0 ? 'pos' : 'neg'}">${fmt(gp)}</b>` +
        (pctLow ? `<br><b class="neg">佣金比例不可低於 ${MIN_COMM_PCT}%</b>` : '');
    } else {
      $('#f_preview').innerHTML =
        `已選 ${n} 台｜實收 <b>${fmt(rev)}</b>｜成本 ${fmt(cost)}${extraTxt}｜毛利 <b class="${rev - cost - extra >= 0 ? 'pos' : 'neg'}">${fmt(rev - cost - extra)}</b>`;
    }
  };
  $('#f_price').oninput = () => {
    if (saleType === 'franchise') { depositMode === 'pct' ? recalcFromPct() : recalcFromDeposit(); }
    else preview();
  };
  $('#f_fee').oninput = preview;
  renderHead(); renderModels(); renderUnits(); renderFixes(); preview();
  if (opts.consignId) {
    const cg = (D.consignments || []).find(x => x.id === opts.consignId);
    if (cg && cg.unit_id) {
      document.querySelector('#f_saletype button[data-t="franchise"]').click();
      sel.add(cg.unit_id);
      prefillFromConsigns();
      renderUnits(); renderFixes(); preview();
      $('#f_saletype').closest('.field').classList.add('hidden');
    }
  }
  window._saleSel = sel;
  window._saleType = () => saleType;
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
  const body = {
    date: $('#f_date').value, customer: $('#f_cust').value.trim(),
    unit_ids: [...sel], total_price: +$('#f_price').value || 0,
    card_fee: +$('#f_fee').value || 0, warranty_no: $('#f_warranty').value.trim(),
    serial_fix: window._saleFix(), note: $('#f_note').value.trim(),
    sale_type: window._saleType(),
    extra_fee: +$('#f_extra').value || 0, extra_label: $('#f_extralbl').value.trim()
  };
  if (window._saleType() === 'franchise') {
    body.agent = $('#f_agent').value.trim();
    body.deposit = +$('#f_deposit').value || 0;
    body.deposit_date = $('#f_depdate').value;
    body.settle_date = $('#f_setdate').value;
    body.tax = +$('#f_tax').value || 0;
    body.health_fee = +$('#f_health').value || 0;
    const comm = body.total_price - body.deposit;
    if (body.total_price > 0 && comm * 10000 < body.total_price * 1211) {
      alert(`佣金比例不可低於 ${MIN_COMM_PCT}%`); return;
    }
  }
  await api('/api/sale', { body });
  closeModal(); await load();
}

/* ---------- consignments (特許領機) ---------- */
function openSaleFormFromConsign(id) { openSaleForm({ consignId: id }); }
async function delConsign(id) {
  if (!confirm('取消特許領機？機器將回到庫存。\n（保證金退還請自行處理，本紀錄將移除）')) return;
  await api('/api/consign/' + id, { method: 'DELETE' });
  await load();
}
async function returnConsign(id) {
  const c = D.consignments.find(x => x.id === id);
  if (!c) return;
  const amt = prompt('退款金額（預設＝保證金）', c.deposit);
  if (amt === null) return;
  if (!confirm(`確認退回？機器回到庫存，退款 ${fmt(+amt || 0)}（記於今日）`)) return;
  await api('/api/consign/' + id + '/return', { body: { refund_amount: +amt || 0 } });
  await load();
}
function openConsignForm() {
  const avail = D.units.filter(u => u.status === 'in_stock');
  if (!avail.length) { alert('目前沒有在庫機器，請先登記進貨'); return; }
  openModal(`<h2>特許領機</h2>
    <div class="two">
      <div class="field"><label>特許人</label><input id="f_agent" list="agentList" placeholder="姓名">
        <datalist id="agentList">${D.agents.map(a => `<option value="${esc(a)}">`).join('')}</datalist></div>
      <div class="field"><label>保證金收款日</label><input id="f_depdate" type="date" value="${today()}"></div>
    </div>
    <div class="field"><label>型號</label><div class="seg" id="f_models"></div></div>
    <div class="field"><label>貨號（單選）</label><div class="unit-chips" id="f_units"></div></div>
    <div class="two">
      <div class="field"><label>保證金（原架售價 70%）</label><input id="f_deposit" type="text" inputmode="numeric" placeholder="0"></div>
      <div class="field"><label>備註（選填）</label><input id="f_note" placeholder="約定售價…"></div>
    </div>
    <div class="preview" id="f_preview"></div>
    <div class="form-actions">
      <button class="btn" onclick="closeModal()">取消</button>
      <button class="btn primary" onclick="submitConsign()">儲存</button>
    </div>`);
  let model = 'ALL';
  let selId = null;
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
      `<button class="${selId === u.id ? 'on' : ''}" data-id="${u.id}">${esc(u.serial)}<span class="c">${model === 'ALL' ? esc(u.model) + '｜' : ''}成本 ${fmt(u.cost)}</span></button>`
    ).join('');
    $('#f_units').querySelectorAll('button').forEach(b => b.onclick = () => {
      const id = +b.dataset.id;
      selId = selId === id ? null : id;
      renderUnits(); preview();
    });
  };
  const preview = () => {
    const dep = +$('#f_deposit').value || 0;
    const u = avail.find(x => x.id === selId);
    $('#f_preview').innerHTML = u
      ? `保證金(暫收) <b>${fmt(dep)}</b>｜${$('#f_depdate').value || '—'} 收款｜機器 ${esc(u.serial)} 交由 ${esc($('#f_agent').value.trim() || '—')}`
      : '請選擇貨號';
  };
  ['#f_deposit', '#f_depdate', '#f_agent'].forEach(sel => $(sel).oninput = preview);
  renderModels(); renderUnits(); preview();
  window._cnSel = () => selId;
}
async function submitConsign() {
  await api('/api/consign', {
    body: {
      agent: $('#f_agent').value.trim(), unit_id: window._cnSel(),
      deposit: +$('#f_deposit').value || 0, deposit_date: $('#f_depdate').value,
      note: $('#f_note').value.trim()
    }
  });
  closeModal(); await load();
}
function openConsignEditForm(id) {
  const c = D.consignments.find(x => x.id === id);
  if (!c) return;
  openModal(`<h2>編輯特許領機</h2>
    <div class="two">
      <div class="field"><label>特許人</label><input id="f_agent" list="agentList" value="${esc(c.agent)}">
        <datalist id="agentList">${D.agents.map(a => `<option value="${esc(a)}">`).join('')}</datalist></div>
      <div class="field"><label>保證金收款日</label><input id="f_depdate" type="date" value="${c.deposit_date}"></div>
    </div>
    <div class="field"><label>機器（不可更換，如錯誤請刪除重登）</label><div class="unit-chips">
      <button disabled style="opacity:.75">${esc(c.serial || '—')}<span class="c">${esc(c.model || '')}</span></button>
    </div></div>
    <div class="two">
      <div class="field"><label>保證金</label><input id="f_deposit" type="text" inputmode="numeric" value="${c.deposit}"></div>
      <div class="field"><label>備註</label><input id="f_note" value="${esc(c.note)}"></div>
    </div>
    <div class="form-actions">
      <button class="btn" onclick="closeModal()">取消</button>
      <button class="btn primary" onclick="submitConsignEdit(${c.id})">儲存</button>
    </div>`);
}
async function submitConsignEdit(id) {
  await api('/api/consign/' + id, {
    method: 'PATCH',
    body: {
      agent: $('#f_agent').value.trim(), deposit: +$('#f_deposit').value || 0,
      deposit_date: $('#f_depdate').value, note: $('#f_note').value.trim()
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
    <div class="field"><label>金額（總額）</label><input id="f_total" type="text" inputmode="numeric" value="${p.total}"></div>
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
      <div class="field"><label>數量</label><input id="f_qty" type="text" inputmode="numeric" value="1" min="1"></div>
    </div>
    <div class="field"><label>型號</label><div class="seg" id="f_models"></div></div>
    <div class="field"><label>入庫類型</label><div class="seg" id="f_ptype"></div></div>
    <div class="field"><label>金額（總額）</label><input id="f_total" type="text" inputmode="numeric" placeholder="0"></div>
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
      trial: D.units.filter(u => u.model === mo && u.status === 'trial').length,
      consigned: D.units.filter(u => u.model === mo && u.status === 'consigned').length
    };
  });
  const chips = MODELS.filter(mo => counts[mo].stock + counts[mo].trial + counts[mo].consigned > 0 || D.units.some(u => u.model === mo)).map(mo =>
    `<div class="chip-card"><div class="num">${counts[mo].stock}</div>
     <div class="lbl">${esc(mo)}${counts[mo].trial ? `（＋試用 ${counts[mo].trial}）` : ''}${counts[mo].consigned ? `（＋特許 ${counts[mo].consigned}）` : ''}</div></div>`).join('');
  const filters = [['active', '在庫＋試用＋特許'], ['sold', '已售'], ['all', '全部']].map(([k, l]) =>
    `<button class="${stockFilter === k ? 'on' : ''}" onclick="setStockFilter('${k}')">${l}</button>`).join('');
  const units = D.units.filter(u =>
    stockFilter === 'all' ? true :
    stockFilter === 'sold' ? u.status === 'sold' :
    (u.status === 'in_stock' || u.status === 'trial' || u.status === 'consigned'));
  const badge = u => {
    const cls = { in_stock: 'ok', trial: 'warn', sold: 'mut', retired: 'bad', consigned: 'warn' }[u.status];
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
  const statusOpts = (u.status === 'sold' ? ['sold'] : u.status === 'consigned' ? ['consigned'] : ['in_stock', 'trial', 'retired'])
    .map(s => `<option value="${s}" ${u.status === s ? 'selected' : ''}>${STATUS_LABEL[s]}</option>`).join('');
  openModal(`<h2>編輯機器</h2>
    <div class="field"><label>貨號</label><input id="f_serial" value="${esc(u.serial)}" ${editable ? '' : 'disabled'}></div>
    <div class="two">
      <div class="field"><label>成本</label><input id="f_cost" type="text" inputmode="numeric" value="${u.cost}" ${editable ? '' : 'disabled'}></div>
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
  const hasCommission = rows.some(r => r.commission > 0);
  const hasExtra = rows.some(r => r.extra > 0);
  const tot = rows.reduce((a, r) => ({
    revenue: a.revenue + r.revenue, cost: a.cost + r.cost, commission: a.commission + r.commission,
    extra: a.extra + r.extra, profit: a.profit + r.profit, qty: a.qty + r.qty
  }), { revenue: 0, cost: 0, commission: 0, extra: 0, profit: 0, qty: 0 });
  const max = Math.max(...rows.map(r => r.revenue), 1);
  const W = 660, H = 200, bw = Math.min(44, (W - 40) / rows.length / 1.6);
  const bars = rows.map((r, i) => {
    const x = 30 + i * ((W - 40) / rows.length);
    const hr = r.revenue / max * (H - 30), hp = Math.max(0, r.profit) / max * (H - 30);
    return `<rect x="${x}" y="${H - 20 - hr}" width="${bw}" height="${hr}" rx="4" fill="#3b4a9f" opacity=".85"/>
      <rect x="${x + bw * .45}" y="${H - 20 - hp}" width="${bw * .55}" height="${hp}" rx="3" fill="#1a8f5c"/>
      <text x="${x + bw / 2}" y="${H - 5}" font-size="10" text-anchor="middle" fill="#6b7290">${r.ym.slice(5)}</text>`;
  }).join('');
  let html = `<div class="chart-card">
      <div class="legend"><span><span class="dot" style="background:#3b4a9f"></span>銷售</span>
      <span><span class="dot" style="background:#1a8f5c"></span>毛利</span></div>
      <svg viewBox="0 0 ${W} ${H}" style="width:100%">${bars}</svg>
    </div>
    <table>
      <tr><th>月份</th><th>銷售總額</th><th>成本</th>${hasCommission ? '<th>佣金</th>' : ''}${hasExtra ? '<th>其他費用</th>' : ''}<th>毛利</th><th>台數</th><th>毛利率</th></tr>
      ${rows.map(r => `<tr><td>${r.ym}</td><td>${fmt(r.revenue)}</td><td>${fmt(r.cost)}</td>${hasCommission ? `<td>${fmt(r.commission)}</td>` : ''}${hasExtra ? `<td>${fmt(r.extra)}</td>` : ''}
        <td class="${r.profit >= 0 ? 'pos' : 'neg'}">${fmt(r.profit)}</td><td>${r.qty}</td>
        <td>${r.revenue ? (r.profit / r.revenue * 100).toFixed(1) : '0.0'}%</td></tr>`).join('')}
      <tr class="total"><td>合計</td><td>${fmt(tot.revenue)}</td><td>${fmt(tot.cost)}</td>${hasCommission ? `<td>${fmt(tot.commission)}</td>` : ''}${hasExtra ? `<td>${fmt(tot.extra)}</td>` : ''}
        <td>${fmt(tot.profit)}</td><td>${tot.qty}</td>
        <td>${tot.revenue ? (tot.profit / tot.revenue * 100).toFixed(1) : '0.0'}%</td></tr>
    </table>`;
  if (D.franchise_flow && D.franchise_flow.length) {
    const frows = D.franchise_flow;
    const net = r => r.dep_in - r.dep_out - r.comm_net - r.tax - r.health;
    const ftot = frows.reduce((a, r) => ({
      dep_in: a.dep_in + r.dep_in, dep_out: a.dep_out + r.dep_out, comm_net: a.comm_net + r.comm_net,
      tax: a.tax + r.tax, health: a.health + r.health
    }), { dep_in: 0, dep_out: 0, comm_net: 0, tax: 0, health: 0 });
    const tnet = net(ftot);
    html += `<h2 class="section">特許金流（現金收支）</h2>
    <div style="overflow-x:auto"><table>
      <tr><th>月份</th><th>保證金收</th><th>退保證金</th><th>實付佣金</th><th>預扣稅款</th><th>補充保費</th><th>淨流</th></tr>
      ${frows.map(r => `<tr><td>${r.ym}</td><td>${fmt(r.dep_in)}</td><td>${fmt(r.dep_out)}</td><td>${fmt(r.comm_net)}</td>
        <td>${fmt(r.tax)}</td><td>${fmt(r.health)}</td><td class="${net(r) >= 0 ? 'pos' : 'neg'}">${fmt(net(r))}</td></tr>`).join('')}
      <tr class="total"><td>合計</td><td>${fmt(ftot.dep_in)}</td><td>${fmt(ftot.dep_out)}</td><td>${fmt(ftot.comm_net)}</td>
        <td>${fmt(ftot.tax)}</td><td>${fmt(ftot.health)}</td><td class="${tnet >= 0 ? 'pos' : 'neg'}">${fmt(tnet)}</td></tr>
    </table></div>`;
  }
  return html;
}

/* ---------- boot ---------- */
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
load().catch(() => showLogin());
