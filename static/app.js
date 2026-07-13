'use strict';
const $ = s => document.querySelector(s);
const MODELS = ['High Grade', 'Standard', 'Charge', 'Pet'];
const PREFIX = { 'High Grade': 'HG', 'Standard': 'ST', 'Charge': 'CH', 'Pet': 'PT' };
const STATUS_LABEL = { in_stock: '在庫', sold: '已售', trial: '試用機', retired: '除役', consigned: '特許機' };
const RENT_LABEL = { week7: '七天租', month: '月租', franchise: '特許租用', hq: '總部月租', reserve: '預約' };
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

const SEARCH = { sales: '', purchases: '', stock: '', trials: '' };
const PERIOD = { sales: 'm3', purchases: 'm3' };
let reportPeriod = 'm12';

function getPeriodStart(periodType) {
  if (periodType === 'm3') {
    const d = new Date();
    const targetDate = new Date(d.getFullYear(), d.getMonth() - 2, 1);
    const ty = targetDate.getFullYear();
    const tm = targetDate.getMonth();
    return `${ty}-${String(tm + 1).padStart(2, '0')}-01`;
  }
  return null;
}

window.setSearch = (key, val) => {
  SEARCH[key] = val;
  render();
  const el = document.querySelector('.page-search');
  if (el) {
    el.focus();
    try {
      el.setSelectionRange(el.value.length, el.value.length);
    } catch (e) {}
  }
};

window.setPeriod = (key, val) => {
  PERIOD[key] = val;
  render();
};

window.setReportPeriod = (val) => {
  reportPeriod = val;
  render();
};

let D = null;
let tab = 'sales';
let cachedUsers = [];
let cachedUserBackups = [];
let cachedSysBackups = [];
let lastActiveElement = null;

/* ---------- api ---------- */
async function api(path, opts = {}) {
  if (opts.body) {
    opts.method = opts.method || 'POST';
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(opts.body);
  }
  let r;
  try {
    r = await fetch(path, opts);
  } catch (err) {
    if (err instanceof TypeError) {
      alert('連線失敗，請確認網路後再試');
    }
    throw err;
  }
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
  cachedUserBackups = j.user_backups;
  cachedSysBackups = j.system_backups;
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
    ${j.user_backups.map((b, i) => `<div class="card row">
      <div class="grow">
        <div class="title" style="font-size:15px">${esc(fmtU(b.name))}</div>
        <div class="sub">${esc(b.name)}｜${Math.round(b.size / 1024)} KB</div>
      </div>
      <button class="btn danger" onclick="restoreBackup('user', ${i})">還原</button>
    </div>`).join('') || '<div class="empty" style="padding:14px 0">尚無備份</div>'}
    ${isAdmin ? `
    <h2 class="section">系統備份（整個資料庫，影響所有使用者）</h2>
    ${j.system_backups.map((b, i) => `<div class="card row">
      <div class="grow">
        <div class="title" style="font-size:15px">${esc(fmtS(b.name))}</div>
        <div class="sub">${esc(b.name)}｜${Math.round(b.size / 1024)} KB</div>
      </div>
      <button class="btn danger" onclick="restoreBackup('sys', ${i})">全系統還原</button>
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
async function restoreBackup(type, index) {
  const list = type === 'user' ? cachedUserBackups : cachedSysBackups;
  const b = list[index];
  if (!b) return;
  const name = b.name;
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
  cachedUsers = j.users;
  $('#userAdmin').innerHTML = j.users.map(u => `<div class="card row">
      <div class="grow">
        <div class="title">${esc(u.username)} ${u.is_admin ? '<span class="badge">管理員</span>' : '<span class="badge mut">一般</span>'}</div>
        <div class="sub">銷售 ${u.counts.sales}｜機器 ${u.counts.units}｜進貨 ${u.counts.purchases}｜試用 ${u.counts.trials}</div>
      </div>
      <button class="icon-btn" title="重設密碼" onclick="resetUserPw(${u.id})">🔑</button>
      <button class="icon-btn" title="${u.is_admin ? '降為一般' : '升為管理員'}" onclick="toggleAdmin(${u.id})">${u.is_admin ? '⬇️' : '⬆️'}</button>
      <button class="icon-btn" onclick="deleteUser(${u.id})">🗑</button>
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
async function resetUserPw(id) {
  const u = cachedUsers.find(x => x.id === id);
  if (!u) return;
  const pw = prompt(`為「${u.username}」設定新密碼（至少 8 碼）：`);
  if (!pw) return;
  await api('/api/users/' + id, { method: 'PATCH', body: { password: pw } });
  alert('已重設密碼');
}
async function toggleAdmin(id) {
  const u = cachedUsers.find(x => x.id === id);
  if (!u) return;
  if (!confirm(`${u.is_admin ? '取消' : '賦予'}「${u.username}」的管理員權限？`)) return;
  await api('/api/users/' + id, { method: 'PATCH', body: { is_admin: u.is_admin ? 0 : 1 } });
  renderUserAdmin();
}
async function deleteUser(id) {
  const u = cachedUsers.find(x => x.id === id);
  if (!u) return;
  if (!confirm(`刪除使用者「${u.username}」及其全部資料？\n\n（該使用者的資料會先自動保存一份備份檔）`)) return;
  await api('/api/users/' + id, { method: 'DELETE' });
  renderUserAdmin();
}

/* ---------- modal ---------- */
function openModal(html) {
  lastActiveElement = document.activeElement;
  const card = $('#modalCard');
  card.innerHTML = html;
  $('#modal').classList.remove('hidden');
  card.focus();
}
function closeModal() {
  $('#modal').classList.add('hidden');
  $('#modalCard').innerHTML = '';
  if (lastActiveElement) {
    lastActiveElement.focus();
    lastActiveElement = null;
  }
}


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
  const searchInput = `<input type="search" class="page-search" placeholder="搜尋…" value="${esc(SEARCH.sales)}" oninput="setSearch('sales', this.value)">`;
  const periodSeg = `<div class="seg" style="margin-bottom:12px">
    <button class="${PERIOD.sales === 'm1' ? 'on' : ''}" onclick="setPeriod('sales', 'm1')">本月</button>
    <button class="${PERIOD.sales === 'm3' ? 'on' : ''}" onclick="setPeriod('sales', 'm3')">近3個月</button>
    <button class="${PERIOD.sales === 'all' ? 'on' : ''}" onclick="setPeriod('sales', 'all')">全部</button>
  </div>`;

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

  const groups = [];
  const groupMap = {};

  D.sales.forEach(s => {
    if (s.group_id !== null && s.group_id !== undefined) {
      if (!groupMap[s.group_id]) {
        const g = {
          group_id: s.group_id,
          rows: [],
          anchor: null,
          matchesSearch: false,
        };
        groupMap[s.group_id] = g;
        groups.push(g);
      }
      groupMap[s.group_id].rows.push(s);
    } else {
      groups.push({
        group_id: null,
        rows: [s],
        anchor: s,
        matchesSearch: false,
      });
    }
  });

  groups.forEach(g => {
    if (g.group_id !== null) {
      g.anchor = g.rows.find(r => r.id === g.group_id) || g.rows[0];
    }
  });

  const q = SEARCH.sales ? SEARCH.sales.toLowerCase() : '';
  groups.forEach(g => {
    if (!q) {
      g.matchesSearch = true;
    } else {
      g.matchesSearch = g.rows.some(s =>
        (s.customer || '').toLowerCase().includes(q) ||
        (s.serial || '').toLowerCase().includes(q) ||
        (s.model || '').toLowerCase().includes(q) ||
        (s.agent || '').toLowerCase().includes(q) ||
        (s.note || '').toLowerCase().includes(q)
      );
    }
  });

  let filteredGroups = groups.filter(g => g.matchesSearch);
  const totalAfterSearch = groups.filter(g => g.matchesSearch).reduce((sum, g) => sum + g.rows.length, 0);

  if (PERIOD.sales === 'm1') {
    const currentYm = today().slice(0, 7);
    filteredGroups = filteredGroups.filter(g => g.anchor.date.slice(0, 7) === currentYm);
  } else if (PERIOD.sales === 'm3') {
    const pStart = getPeriodStart('m3');
    filteredGroups = filteredGroups.filter(g => g.anchor.date >= pStart);
  }

  const totalDisplayedRows = filteredGroups.reduce((sum, g) => sum + g.rows.length, 0);
  const hiddenCount = totalAfterSearch - totalDisplayedRows;

  let listHtml = '';
  if (!D.sales.length && !consignHtml && !banner && !agentOwingHtml) {
    listHtml = '<div class="empty">尚無銷售紀錄，按＋新增</div>';
  } else if (!filteredGroups.length) {
    listHtml = '<div class="empty">無符合搜尋或篩選的銷售紀錄</div>';
  } else {
    const byMonth = {};
    filteredGroups.forEach(g => {
      const ym = g.anchor.date.slice(0, 7);
      byMonth[ym] = byMonth[ym] || [];
      byMonth[ym].push(g);
    });

    listHtml = Object.keys(byMonth).sort().reverse().map(ym => {
      const monthGroups = byMonth[ym];
      let rev = 0;
      let profit = 0;
      let rowsCount = 0;
      monthGroups.forEach(g => {
        g.rows.forEach(s => {
          rev += s.price - s.card_fee;
          profit += s.price - s.card_fee - s.cost - (s.commission || 0) - (s.extra_fee || 0);
          rowsCount += 1;
        });
      });

      const cardsHtml = monthGroups.map(g => {
        const n = g.rows.length;
        const anchor = g.anchor;
        const isFr = anchor.sale_type === 'franchise';

        const titleCustomer = esc(anchor.customer);
        const titleBadge = n > 1 ? ` <span class="badge">${n} 台</span>` : '';

        const uniqueModels = [...new Set(g.rows.map(r => r.model).filter(Boolean))];
        const modelBadge = uniqueModels.length ? ` <span class="badge">${esc(uniqueModels.join('／'))}</span>` : '';
        const franchiseBadge = isFr ? ' <span class="badge">居間特許</span>' : '';

        const dateAgent = `${anchor.date}${isFr ? '｜特許人 ' + esc(anchor.agent) : ''}`;
        const serials = g.rows.map(r => r.serial).filter(Boolean);
        const serialsJoined = serials.length ? `｜${esc(serials.join('・'))}` : '';
        const warranty = anchor.warranty_no ? `｜保固 ${esc(anchor.warranty_no)}` : '';
        const cardFee = anchor.card_fee ? `｜刷卡費 ${fmt(anchor.card_fee)}` : '';
        const extraFee = anchor.extra_fee ? `｜${esc(anchor.extra_label || '其他費用')} ${fmt(anchor.extra_fee)}` : '';
        const note = anchor.note ? `｜${esc(anchor.note)}` : '';

        const subLine1 = dateAgent + serialsJoined + warranty + cardFee + extraFee + note;

        const moneyRow = isFr && (anchor.deposit > 0 || anchor.commission > 0);
        const moneyLineHtml = moneyRow ? `<div class="sub">保證金 ${fmt(anchor.deposit)}（${anchor.deposit_date.slice(5)} 暫收）｜佣金 ${fmt(anchor.commission)}（稅 ${fmt(anchor.tax)}｜補 ${fmt(anchor.health_fee)}｜實付 ${fmt(anchor.commission - anchor.tax - anchor.health_fee)}）${!anchor.settled && anchor.settle_date ? `｜預計 ${anchor.settle_date.slice(5)} 結清` : ''}</div>` : '';

        const totalGroupPrice = g.rows.reduce((sum, s) => sum + s.price, 0);
        const totalGroupCardFee = g.rows.reduce((sum, s) => sum + s.card_fee, 0);
        const groupAmount = totalGroupPrice - totalGroupCardFee;
        const groupProfit = g.rows.reduce((sum, s) => sum + s.price - s.card_fee - s.cost - (s.commission || 0) - (s.extra_fee || 0), 0);

        const onclickAction = n > 1 ? `openSaleGroupEditForm(${anchor.group_id})` : `openSaleEditForm(${anchor.id})`;
        const deleteAction = n > 1 ? `delSaleGroup(${anchor.group_id})` : `delSale(${anchor.id})`;
        const settleAction = n > 1 ? `settleSaleGroup(${anchor.group_id})` : `settleSale(${anchor.id})`;

        return `<div class="card row" onclick="${onclickAction}" style="cursor:pointer">
          <div class="grow">
            <div class="title">${titleCustomer}${titleBadge}${modelBadge}${franchiseBadge}</div>
            <div class="sub">${subLine1}</div>
            ${moneyLineHtml}
          </div>
          <div class="amount">${fmt(groupAmount)}<div class="sub ${groupProfit >= 0 ? 'pos' : 'neg'}">毛利 ${fmt(groupProfit)}</div></div>
          ${moneyRow ? `<span class="badge ${anchor.settled ? 'mut' : 'warn'}">${anchor.settled ? '已結清' : '未結清'}</span>` : ''}
          ${moneyRow && !anchor.settled ? `<button class="btn" onclick="event.stopPropagation();${settleAction}">結清</button>` : ''}
          <button class="icon-btn" onclick="event.stopPropagation();${deleteAction}">🗑</button>
        </div>`;
      }).join('');

      return `<h2 class="section">${ym}　銷售 ${fmt(rev)}｜毛利 ${fmt(profit)}｜${rowsCount} 台</h2>` + cardsHtml;
    }).join('');
  }

  const hiddenHtml = hiddenCount > 0 ? `<div class="empty">較舊紀錄已隱藏 — 按「全部」顯示</div>` : '';

  return searchInput + periodSeg + banner + agentOwingHtml + consignHtml + listHtml + hiddenHtml;
}
async function delSale(id) {
  const s = D.sales.find(x => x.id === id);
  const msg = (s && s.sale_type === 'franchise' && s.deposit > 0)
    ? '刪除此筆銷售？此筆為居間特許且有保證金：機器會改回「特許持機中」，保證金紀錄保留。'
    : '刪除此筆銷售？機器會回到庫存。';
  if (!confirm(msg)) return;
  await api('/api/sale/' + id, { method: 'DELETE' });
  await load();
}
async function delSaleGroup(gid) {
  const gRows = D.sales.filter(s => s.group_id === gid);
  if (!gRows.length) return;
  const anchor = gRows.find(r => r.id === gid) || gRows[0];
  const n = gRows.length;
  const isFr = anchor.sale_type === 'franchise';
  const hasDep = anchor.deposit > 0;
  const outcomeLine = (isFr && hasDep)
    ? `第一台（${esc(anchor.serial)}）記回特許持機（保證金全額），其餘機器回到庫存；如與實際持機情況不符，請於特許領機手動修正。`
    : `機器會回到庫存。`;
  const msg = `注意：將同時刪除 ${n} 台機器的銷售紀錄。\n${outcomeLine}`;
  if (!confirm(msg)) return;
  await api('/api/sale-group/' + gid, { method: 'DELETE' });
  await load();
}
window.doSettleSale = async (id) => {
  const btn = $('#confirmSettleBtn');
  if (btn.disabled) return;
  btn.disabled = true;
  try {
    const settle_date = $('#settle_date_input').value;
    await api('/api/sale/' + id, { method: 'PATCH', body: { settled: 1, settle_date } });
    closeModal();
    await load();
  } catch (e) {
    btn.disabled = false;
  }
};
function settleSale(id) {
  const s = D.sales.find(x => x.id === id);
  if (!s) return;
  const netComm = s.commission - s.tax - s.health_fee;
  const payout = s.deposit + netComm;
  const d = s.settle_date || today();
  openModal(`<h2>確認結清（居間特許）</h2>
    <div style="margin-bottom:14px;font-size:15px;line-height:1.6;color:var(--ink)">
      <div>客戶：${esc(s.customer)}</div>
      <div>退保證金：${fmt(s.deposit)}</div>
      <div>實付佣金：${fmt(netComm)}</div>
      <div style="font-weight:bold;margin-top:4px">合計：${fmt(payout)}</div>
    </div>
    <div class="field">
      <label for="settle_date_input">結清日</label>
      <input id="settle_date_input" type="date" value="${d}">
    </div>
    <div class="form-actions">
      <button class="btn" onclick="closeModal()">取消</button>
      <button class="btn primary" id="confirmSettleBtn" onclick="doSettleSale(${id})">確認結清 ${fmt(payout)}</button>
    </div>`);
}
function settleSaleGroup(gid) {
  const gRows = D.sales.filter(s => s.group_id === gid);
  if (!gRows.length) return;
  const anchor = gRows.find(r => r.id === gid) || gRows[0];
  const netComm = anchor.commission - anchor.tax - anchor.health_fee;
  const payout = anchor.deposit + netComm;
  const d = anchor.settle_date || today();
  openModal(`<h2>確認結清（整組居間特許）</h2>
    <div style="margin-bottom:14px;font-size:15px;line-height:1.6;color:var(--ink)">
      <div>客戶：${esc(anchor.customer)}（共 ${gRows.length} 台）</div>
      <div>退保證金：${fmt(anchor.deposit)}</div>
      <div>實付佣金：${fmt(netComm)}</div>
      <div style="font-weight:bold;margin-top:4px">合計：${fmt(payout)}</div>
    </div>
    <div class="field">
      <label for="settle_group_date_input">結清日</label>
      <input id="settle_group_date_input" type="date" value="${d}">
    </div>
    <div class="form-actions">
      <button class="btn" onclick="closeModal()">取消</button>
      <button class="btn primary" id="confirmGroupSettleBtn">確認結清 ${fmt(payout)}</button>
    </div>`);
  $('#confirmGroupSettleBtn').onclick = async () => {
    const btn = $('#confirmGroupSettleBtn');
    if (btn.disabled) return;
    btn.disabled = true;
    try {
      const settle_date = $('#settle_group_date_input').value;
      await api('/api/sale-group/' + gid + '/settle', { method: 'POST', body: { settle_date } });
      closeModal();
      await load();
    } catch (e) {
      btn.disabled = false;
    }
  };
}
function openSaleGroupEditForm(gid) {
  const gRows = D.sales.filter(s => s.group_id === gid);
  if (!gRows.length) return;
  const anchor = gRows.find(r => r.id === gid) || gRows[0];
  const n = gRows.length;
  const isFr0 = anchor.sale_type === 'franchise';
  const totalPriceVal = gRows.reduce((a, s) => a + s.price, 0);
  const dep0 = isFr0 ? anchor.deposit : halfUp(totalPriceVal * (100 - DEFAULT_COMM_PCT) / 100);
  const calc0 = franchiseCalc(totalPriceVal, dep0);
  const comm0 = isFr0 ? anchor.commission : calc0.commission;
  const tax0 = isFr0 ? anchor.tax : calc0.tax;
  const health0 = isFr0 ? anchor.health_fee : calc0.health;
  const pct0 = totalPriceVal > 0 ? +((comm0 / totalPriceVal) * 100).toFixed(2) : DEFAULT_COMM_PCT;
  const depdate0 = (isFr0 && anchor.deposit_date) ? anchor.deposit_date : anchor.date;
  const setdate0 = (isFr0 && anchor.settle_date) ? anchor.settle_date : nextMonth15(anchor.date);
  const serialsList = gRows.map(r => r.serial).filter(Boolean).join('、');
  const statusStr = anchor.settled ? '已結清' : '未結清';
  const summaryLineHtml = `<div class="summary-line" style="margin-bottom:12px;font-size:15px;line-height:1.6;color:var(--ink);background:#f2f3f8;padding:10px;border-radius:8px">
    <strong>${esc(anchor.customer)}</strong>｜共 ${n} 台｜貨號：${esc(serialsList)}<br>
    總價：${fmt(totalPriceVal)}｜結清狀態：${statusStr}
  </div>`;
  openModal(`<h2>編輯銷售群組</h2>
    <div id="f_settle_hint" class="hidden" style="text-align:left;margin-bottom:10px;font-weight:bold;color:var(--mut);background:#f2f3f8;padding:8px 10px;border-radius:8px">已結清－如需修改請先取消結清</div>
    ${summaryLineHtml}
    <div class="field"><label>類別</label><div class="seg" id="f_saletype">
      <button class="${isFr0 ? '' : 'on'}" data-t="normal">一般銷售</button><button class="${isFr0 ? 'on' : ''}" data-t="franchise">居間特許</button>
    </div></div>
    <div id="f_head"></div>
    <div class="two">
      <div class="field"><label>總價</label><input id="f_total_price" type="text" inputmode="numeric" value="${totalPriceVal}"></div>
      <div class="field"><label>刷卡手續費</label><input id="f_fee" type="text" inputmode="numeric" value="${anchor.card_fee}"></div>
    </div>
    <div class="two">
      <div class="field"><label>其他費用（選填）</label><input id="f_extra" type="text" inputmode="numeric" value="${anchor.extra_fee || ''}" placeholder="0"></div>
      <div class="field"><label>費用名稱（選填）</label><input id="f_extralbl" value="${esc(anchor.extra_label || '')}" placeholder="調貨、開發票…"></div>
    </div>
    <div class="two">
      <div class="field"><label>保固書編號</label><input id="f_warranty" value="${esc(anchor.warranty_no || '')}"></div>
      <div class="field"><label>備註</label><input id="f_note" value="${esc(anchor.note)}"></div>
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
        <button class="${(isFr0 && anchor.settled) ? '' : 'on'}" data-s="0">未結清</button><button class="${(isFr0 && anchor.settled) ? 'on' : ''}" data-s="1">已結清</button>
      </div></div>
    </div>
    <div style="margin-top:15px;margin-bottom:15px">
      <button class="btn" id="f_toggle_prices" style="width:100%">調整各台分配</button>
    </div>
    <div id="f_prices_wrap" class="hidden">
      <h2 class="section">各台價格分配</h2>
      <div id="f_prices_list"></div>
    </div>
    <h2 class="section">各台機器</h2>
    <div id="f_units_list" style="display:flex;flex-direction:column;gap:12px"></div>
    <div class="preview" id="f_preview"></div>
    <div class="form-actions">
      <button class="btn" onclick="closeModal()">取消</button>
      <button class="btn primary" id="f_submit_btn" onclick="submitSaleGroupEdit(${gid})">儲存</button>
    </div>`);

  let settled = isFr0 ? anchor.settled : 0;
  let saleType = anchor.sale_type;
  let isPriceSplitMode = false;
  const headVals = { date: anchor.date, cust: anchor.customer, agent: anchor.agent, depdate: depdate0, setdate: setdate0 };

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

  const updatePricesList = () => {
    $('#f_prices_list').innerHTML = gRows.map((r, idx) => `
      <div class="field" style="margin-bottom:8px">
        <label>第 ${idx + 1} 台｜${esc(r.serial)}</label>
        <input class="f_row_price" data-rid="${r.id}" type="text" inputmode="numeric" value="${r.price}" style="height:44px;font-size:16px">
      </div>
    `).join('');

    $('#f_prices_list').querySelectorAll('.f_row_price').forEach(el => {
      el.oninput = () => {
        let sum = 0;
        $('#f_prices_list').querySelectorAll('.f_row_price').forEach(inp => {
          sum += +inp.value || 0;
        });
        $('#f_total_price').value = sum;
        if (saleType === 'franchise') {
          recompute();
        } else {
          preview();
        }
      };
    });
  };

  const updateUnitsList = () => {
    $('#f_units_list').innerHTML = gRows.map((r, idx) => `
      <div style="background:#fafafa;padding:10px;border-radius:8px;border:1px solid #eee">
        <div style="font-weight:bold;margin-bottom:8px">第 ${idx + 1} 台 (${esc(r.model)})</div>
        <div class="two" style="gap:10px">
          <div class="field"><label>貨號</label><input class="f_row_serial" data-rid="${r.id}" value="${esc(r.serial)}" style="height:44px;font-size:16px"></div>
          <div class="field"><label>進貨成本</label><input class="f_row_cost" data-rid="${r.id}" type="text" inputmode="numeric" value="${r.cost}" style="height:44px;font-size:16px"></div>
        </div>
      </div>
    `).join('');

    $('#f_units_list').querySelectorAll('.f_row_cost').forEach(el => {
      el.oninput = preview;
    });
  };

  const preview = () => {
    const totalPrice = +$('#f_total_price').value || 0;
    const fee = +$('#f_fee').value || 0;
    const rev = totalPrice - fee;

    let cost = 0;
    $('#f_units_list').querySelectorAll('.f_row_cost').forEach(inp => {
      cost += +inp.value || 0;
    });

    const extra = +$('#f_extra').value || 0;
    const extraTxt = extra ? `｜${esc($('#f_extralbl').value.trim() || '其他費用')} −${fmt(extra)}` : '';

    if (saleType === 'franchise') {
      const commission = +$('#f_comm').value || 0;
      const netComm = commission - (+$('#f_tax').value || 0) - (+$('#f_health').value || 0);
      const p = rev - cost - commission - extra;
      const pctLow = totalPrice > 0 && commission * 10000 < totalPrice * 1211;
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
    const totalPrice = +$('#f_total_price').value || 0, comm = +$('#f_comm').value || 0;
    if (totalPrice > 0) $('#f_pct').value = +((comm / totalPrice) * 100).toFixed(2);
  };

  const fillTaxHealth = () => {
    const comm = +$('#f_comm').value || 0;
    $('#f_tax').value = halfUp(comm * WITHHOLD_RATE);
    $('#f_health').value = halfUp(comm * HEALTH_RATE);
  };

  const recompute = () => {
    const totalPrice = +$('#f_total_price').value || 0, deposit = +$('#f_deposit').value || 0;
    $('#f_comm').value = totalPrice - deposit;
    syncPct(); fillTaxHealth(); preview();
  };

  const recalcFromPct = () => {
    const totalPrice = +$('#f_total_price').value || 0;
    const pct = Math.min(100, Math.max(0, +$('#f_pct').value || 0));
    const deposit = halfUp(totalPrice * (100 - pct) / 100);
    $('#f_deposit').value = deposit;
    $('#f_comm').value = totalPrice - deposit;
    fillTaxHealth(); preview();
  };

  const updateFreeze = () => {
    const isFrozen = settled && saleType === 'franchise';
    $('#f_settle_hint').classList.toggle('hidden', !isFrozen);
    const inputsToFreeze = [
      '#f_total_price', '#f_fee', '#f_extra',
      '#f_deposit', '#f_comm', '#f_tax', '#f_health',
      '#f_depdate', '#f_setdate', '#f_toggle_prices'
    ];
    inputsToFreeze.forEach(sel => {
      const el = $(sel);
      if (el) el.disabled = isFrozen;
    });
    $('#f_saletype').querySelectorAll('button').forEach(btn => {
      btn.disabled = isFrozen;
    });
    $('#f_prices_list').querySelectorAll('.f_row_price').forEach(inp => {
      inp.disabled = isFrozen;
    });
  };

  $('#f_saletype').querySelectorAll('button').forEach(b => b.onclick = () => {
    saleType = b.dataset.t;
    $('#f_saletype').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    $('#f_franwrap').classList.toggle('hidden', saleType !== 'franchise');
    grab(); renderHead();
    preview();
    updateFreeze();
  });

  $('#f_total_price').oninput = () => { saleType === 'franchise' ? recompute() : preview(); };
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
    const totalPrice = +$('#f_total_price').value || 0;
    $('#f_deposit').value = totalPrice - (+$('#f_comm').value || 0);
    syncPct(); fillTaxHealth(); preview();
  };

  $('#f_toggle_prices').onclick = (e) => {
    e.preventDefault();
    isPriceSplitMode = !isPriceSplitMode;
    $('#f_prices_wrap').classList.toggle('hidden', !isPriceSplitMode);
    $('#f_total_price').readOnly = isPriceSplitMode;
    if (isPriceSplitMode) {
      updatePricesList();
      let sum = 0;
      $('#f_prices_list').querySelectorAll('.f_row_price').forEach(inp => {
        sum += +inp.value || 0;
      });
      $('#f_total_price').value = sum;
      $('#f_toggle_prices').innerText = '取消調整各台分配';
    } else {
      $('#f_toggle_prices').innerText = '調整各台分配';
    }
    preview();
    updateFreeze();
  };

  ['#f_fee', '#f_cost', '#f_tax', '#f_health', '#f_extra', '#f_extralbl', '#f_warranty', '#f_note'].forEach(sel => {
    const el = $(sel);
    if (el) el.oninput = preview;
  });

  $('#f_settled').querySelectorAll('button').forEach(b => b.onclick = () => {
    settled = +b.dataset.s;
    $('#f_settled').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    updateFreeze();
  });

  renderHead(); updateUnitsList(); preview();
  updateFreeze();

  window._seGroupType = () => saleType;
  window._seGroupSettled = () => settled;
  window._seGroupPriceSplitMode = () => isPriceSplitMode;
}
async function submitSaleGroupEdit(gid) {
  const btn = $('#f_submit_btn');
  if (btn.disabled) return;
  btn.disabled = true;
  const saleType = window._seGroupType();
  const settled = window._seGroupSettled();
  const body = {
    date: $('#f_date').value,
    customer: $('#f_cust').value.trim(),
    note: $('#f_note').value.trim(),
    card_fee: +$('#f_fee').value || 0,
    extra_fee: +$('#f_extra').value || 0,
    extra_label: $('#f_extralbl').value.trim(),
    warranty_no: $('#f_warranty').value.trim(),
    sale_type: saleType
  };
  if (saleType === 'franchise') {
    body.agent = $('#f_agent').value.trim();
    body.deposit_date = $('#f_depdate').value;
    body.deposit = +$('#f_deposit').value || 0;
    body.commission = +$('#f_comm').value || 0;
    body.tax = +$('#f_tax').value || 0;
    body.health_fee = +$('#f_health').value || 0;
    body.settled = settled;
    body.settle_date = $('#f_setdate').value;
  }
  if (window._seGroupPriceSplitMode()) {
    const prices = {};
    $('#f_prices_list').querySelectorAll('.f_row_price').forEach(inp => {
      const rid = inp.dataset.rid;
      prices[rid] = +inp.value || 0;
    });
    body.prices = prices;
  } else {
    body.total_price = +$('#f_total_price').value || 0;
  }
  const costs = {};
  $('#f_units_list').querySelectorAll('.f_row_cost').forEach(inp => {
    const rid = inp.dataset.rid;
    costs[rid] = +inp.value || 0;
  });
  body.costs = costs;
  const serials = {};
  $('#f_units_list').querySelectorAll('.f_row_serial').forEach(inp => {
    const rid = inp.dataset.rid;
    serials[rid] = inp.value.trim();
  });
  body.serials = serials;
  try {
    await api('/api/sale-group/' + gid, { method: 'PATCH', body });
    closeModal();
    await load();
  } catch (e) {
    console.error(e);
    btn.disabled = false;
  }
}
window.doSettleAgent = async (idx) => {
  const a = D.agent_owing[idx];
  if (!a) return;
  const agent = a.agent;
  const btn = $('#confirmAgentSettleBtn');
  if (btn.disabled) return;
  btn.disabled = true;
  try {
    const settle_date = $('#agent_settle_date_input').value;
    const j = await api('/api/settle-agent', { body: { agent, settle_date } });
    alert('已結清 ' + j.count + ' 筆');
    closeModal();
    await load();
  } catch (e) {
    btn.disabled = false;
  }
};
function settleAgentIdx(idx) {
  const a = D.agent_owing[idx];
  if (!a) return;
  const agent = a.agent;
  const total = a.payable;
  openModal(`<h2>確認全部結清</h2>
    <div style="margin-bottom:14px;font-size:15px;line-height:1.6;color:var(--ink)">
      <div>特許人：${esc(agent)}</div>
      <div>筆數：${a.n} 筆</div>
      <div>退保證金：${fmt(a.deposit)}</div>
      <div>實付佣金：${fmt(a.net_comm)}</div>
      <div style="font-weight:bold;margin-top:4px">應付合計：${fmt(total)}</div>
    </div>
    <div class="field">
      <label for="agent_settle_date_input">結清日</label>
      <input id="agent_settle_date_input" type="date" value="${today()}">
    </div>
    <div class="form-actions">
      <button class="btn" onclick="closeModal()">取消</button>
      <button class="btn primary" id="confirmAgentSettleBtn" onclick="doSettleAgent(${idx})">確認全部結清 ${fmt(total)}</button>
    </div>`);
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
    <div id="f_settle_hint" class="hidden" style="text-align:left;margin-bottom:10px;font-weight:bold;color:var(--mut);background:#f2f3f8;padding:8px 10px;border-radius:8px">已結清－如需修改請先取消結清</div>
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
  const updateFreeze = () => {
    const isFrozen = settled && saleType === 'franchise';
    $('#f_settle_hint').classList.toggle('hidden', !isFrozen);
    const inputsToFreeze = [
      '#f_price', '#f_fee', '#f_cost', '#f_extra',
      '#f_deposit', '#f_comm', '#f_tax', '#f_health',
      '#f_depdate', '#f_setdate'
    ];
    inputsToFreeze.forEach(sel => {
      const el = $(sel);
      if (el) el.disabled = isFrozen;
    });
    $('#f_saletype').querySelectorAll('button').forEach(btn => {
      btn.disabled = isFrozen;
    });
  };
  $('#f_saletype').querySelectorAll('button').forEach(b => b.onclick = () => {
    saleType = b.dataset.t;
    $('#f_saletype').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    $('#f_franwrap').classList.toggle('hidden', saleType !== 'franchise');
    grab(); renderHead();
    preview();
    updateFreeze();
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
    updateFreeze();
  });
  renderHead(); renderModels(); preview();
  updateFreeze();
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
  try { await api('/api/sale/' + id, { method: 'PATCH', body }); closeModal(); await load(); } catch(e) { console.error(e); }
}

function openSaleForm(opts = {}) {
  const avail = D.units.filter(u => u.status === 'in_stock' || u.status === 'consigned');
  if (!avail.length) { alert('目前沒有在庫機器，請先登記進貨'); return; }
  const consignByUnit = {};
  (D.consignments || []).forEach(c => { if (c.unit_id && !c.returned) consignByUnit[c.unit_id] = c; });
  openModal(`<h2>新增銷售</h2>
    <div class="field"><label>類別</label><div class="seg" id="f_saletype">
      <button class="on" data-t="normal">一般銷售</button><button data-t="franchise">居間特許</button>
    </div></div>
    <div id="f_head"></div>
    <div class="field"><label>型號</label><div class="seg" id="f_models"></div></div>
    <div class="field"><label>貨號（可多選）</label><div class="unit-chips" id="f_units"></div></div>
    <div class="field hidden" id="f_fixwrap"><label>貨號確認／更正（賣出時填實際貨號）</label><div id="f_fixes"></div></div>
    <div class="two">
      <div class="field"><label id="f_price_lbl">銷售總價</label><input id="f_price" type="text" inputmode="numeric" placeholder="0"></div>
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
      <button class="btn primary" id="s_save" onclick="submitSale()">儲存</button>
    </div>`);
  let model = 'ALL';
  const sel = new Set();
  const fixVals = {};
  let saleType = 'normal';
  let depositMode = 'pct';
  let setdateTouched = false;
  const headVals = { date: today(), cust: '', agent: '', depdate: today(), setdate: '', deposit: '' };
  const grab = () => {
    ['date', 'cust', 'agent', 'depdate', 'setdate', 'deposit'].forEach(k => {
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
    if (saleType !== 'franchise') {
      [...sel].forEach(id => { if (consignByUnit[id]) sel.delete(id); });
      const hasConsignedSelected = [...sel].some(id => !!consignByUnit[id]);
      if (!hasConsignedSelected) {
        headVals.agent = ''; headVals.depdate = today(); headVals.deposit = '';
        if ($('#f_deposit')) $('#f_deposit').value = '';
        depositMode = 'pct';
      } else {
        const cs = [...sel].map(id => consignByUnit[id]).filter(Boolean);
        headVals.agent = cs[0].agent; headVals.depdate = cs.map(c => c.deposit_date).filter(Boolean).sort()[0] || today();
        headVals.deposit = cs.reduce((a, c) => a + c.deposit, 0);
        if ($('#f_deposit')) $('#f_deposit').value = headVals.deposit;
        depositMode = 'amount';
      }
    } else depositMode === 'pct' ? recalcFromPct() : recalcFromDeposit();
    renderUnits(); renderFixes(); preview();
  });
  $('#f_pct').oninput = () => { depositMode = 'pct'; recalcFromPct(); };
  $('#f_pct').onblur = () => {
    const val = $('#f_pct').value;
    if (val !== '' && +val < MIN_COMM_PCT) {
      $('#f_pct').value = MIN_COMM_PCT; depositMode = 'pct'; recalcFromPct();
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
    headVals.agent = cs[0].agent;
    headVals.deposit = cs.reduce((a, c) => a + c.deposit, 0);
    headVals.depdate = cs.map(c => c.deposit_date).filter(Boolean).sort()[0] || today();
    if ($('#f_agent')) $('#f_agent').value = headVals.agent;
    if ($('#f_deposit')) $('#f_deposit').value = headVals.deposit;
    if ($('#f_depdate')) $('#f_depdate').value = headVals.depdate;
    depositMode = 'amount';
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
  const saveBtn = $('#s_save');
  if (saveBtn && saveBtn.disabled) return;
  if (saveBtn) saveBtn.disabled = true;
  try {
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
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
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
      <div class="field"><label>保證金（自動＝售價−佣金）</label><input id="f_deposit" type="text" inputmode="numeric" placeholder="0"></div>
      <div class="field"><label>備註（選填）</label><input id="f_note" placeholder="約定售價…"></div>
    </div>
    <div class="preview" id="f_preview"></div>
    <div class="form-actions">
      <button class="btn" onclick="closeModal()">取消</button>
      <button class="btn primary" id="c_save" onclick="submitConsign()">儲存</button>
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
  const saveBtn = $('#c_save');
  if (saveBtn && saveBtn.disabled) return;
  if (saveBtn) saveBtn.disabled = true;
  try {
  await api('/api/consign', {
    body: {
      agent: $('#f_agent').value.trim(), unit_id: window._cnSel(),
      deposit: +$('#f_deposit').value || 0, deposit_date: $('#f_depdate').value,
      note: $('#f_note').value.trim()
    }
  });
  closeModal(); await load();
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
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
  const searchInput = `<input type="search" class="page-search" placeholder="搜尋…" value="${esc(SEARCH.purchases)}" oninput="setSearch('purchases', this.value)">`;
  const periodSeg = `<div class="seg" style="margin-bottom:12px">
    <button class="${PERIOD.purchases === 'm1' ? 'on' : ''}" onclick="setPeriod('purchases', 'm1')">本月</button>
    <button class="${PERIOD.purchases === 'm3' ? 'on' : ''}" onclick="setPeriod('purchases', 'm3')">近3個月</button>
    <button class="${PERIOD.purchases === 'all' ? 'on' : ''}" onclick="setPeriod('purchases', 'all')">全部</button>
  </div>`;

  let filteredPurchases = D.purchases;
  if (SEARCH.purchases) {
    const q = SEARCH.purchases.toLowerCase();
    filteredPurchases = filteredPurchases.filter(p => {
      const matchModel = (p.model || '').toLowerCase().includes(q);
      const matchNote = (p.note || '').toLowerCase().includes(q);
      const matchSerials = D.units.some(u => u.purchase_id === p.id && (u.serial || '').toLowerCase().includes(q));
      return matchModel || matchNote || matchSerials;
    });
  }

  const totalAfterSearch = filteredPurchases.length;
  if (PERIOD.purchases === 'm1') {
    const currentYm = today().slice(0, 7);
    filteredPurchases = filteredPurchases.filter(p => p.date.slice(0, 7) === currentYm);
  } else if (PERIOD.purchases === 'm3') {
    const pStart = getPeriodStart('m3');
    filteredPurchases = filteredPurchases.filter(p => p.date >= pStart);
  }
  const hiddenCount = totalAfterSearch - filteredPurchases.length;

  let listHtml = '';
  if (!D.purchases.length) {
    listHtml = '<div class="empty">尚無進貨紀錄，按＋新增</div>';
  } else if (!filteredPurchases.length) {
    listHtml = '<div class="empty">無符合搜尋或篩選的進貨紀錄</div>';
  } else {
    listHtml = filteredPurchases.map(p => {
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

  const hiddenHtml = hiddenCount > 0 ? `<div class="empty">較舊紀錄已隱藏 — 按「全部」顯示</div>` : '';

  return searchInput + periodSeg + listHtml + hiddenHtml;
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
    ? `<h2 class="section">此筆機器（可直接修改貨號）</h2>` +
      units.map((u, i) => `<div class="field">
        <label for="pes_${u.id}">第 ${i+1} 台｜${STATUS_LABEL[u.status]}｜成本 ${fmt(u.cost)}${u.status === 'sold' ? '（改貨號會同步銷售紀錄）' : ''}</label>
        <input id="pes_${u.id}" class="pe-serial" data-uid="${u.id}" value="${esc(u.serial)}" autocapitalize="characters" spellcheck="false" autocomplete="off">
      </div>`).join('') +
      `<div class="preview" style="background:#f2f3f8;color:var(--mut)">增減台數：請刪除此筆進貨後重新登記（已有售出／試用／特許持機者無法刪除）</div>`
    : '';
  openModal(`<h2>編輯進貨</h2>
    <div class="two">
      <div class="field"><label>日期</label><input id="f_date" type="date" value="${p.date}"></div>
      <div class="field"><label>型號</label><input id="f_model" list="modelList" value="${esc(p.model)}">
        <datalist id="modelList">${MODELS.map(m => `<option value="${esc(m)}">`).join('')}</datalist></div>
    </div>
    <div class="two">
      <div class="field"><label>金額（總額）</label><input id="f_total" type="text" inputmode="numeric" value="${p.total}"></div>
      ${units.length ? '' : `
        <div class="field">
          <label style="display:flex;align-items:center;justify-content:space-between">
            台數（帳目紀錄）
            <button class="btn" style="min-height:44px;padding:4px 12px;font-size:14px;margin:0" onclick="openSplitForm(${p.id})">✂️ 拆單（每型號一筆）</button>
          </label>
          <input id="f_qty" type="text" inputmode="numeric" value="${p.qty}">
        </div>
      `}
    </div>
    ${unitList}
    <div class="field"><label>備註</label><input id="f_note" value="${esc(p.note)}"></div>
    <div class="preview" id="f_preview"></div>
    <div class="form-actions">
      <button class="btn" onclick="closeModal()">取消</button>
      <button class="btn primary" id="pe_save" onclick="submitPurchaseEdit(${p.id})">儲存</button>
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

function openSplitForm(id) {
  const p = D.purchases.find(x => x.id === id);
  if (!p) return;
  
  let splitRows = [
    { model: p.model, qty: p.qty, total: p.total },
    { model: '', qty: '', total: '' }
  ];

  const syncSplitFromDOM = () => {
    const rows = document.querySelectorAll('.split-row-item');
    rows.forEach((r, idx) => {
      const modelInp = r.querySelector('.split-model');
      const qtyInp = r.querySelector('.split-qty');
      const totalInp = r.querySelector('.split-total');
      if (splitRows[idx]) {
        splitRows[idx].model = modelInp ? modelInp.value.trim() : '';
        splitRows[idx].qty = qtyInp ? qtyInp.value.trim() : '';
        splitRows[idx].total = totalInp ? totalInp.value.trim() : '';
      }
    });
  };

  const renderSplitForm = () => {
    let rowsHtml = splitRows.map((row, idx) => {
      const removeBtn = idx > 0
        ? `<button class="btn" style="min-height:44px;padding:0 12px;margin:0" onclick="removeSplitRow(${idx})">✕</button>`
        : `<div style="width:38px"></div>`;
      return `
        <div class="split-row-item" style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
          <div style="flex:2">
            <input class="split-model" list="modelList" placeholder="型號" value="${esc(row.model)}" style="margin:0">
          </div>
          <div style="flex:1">
            <input class="split-qty" type="text" inputmode="numeric" placeholder="台數" value="${esc(row.qty)}" style="margin:0" oninput="updateSplitPreview()">
          </div>
          <div style="flex:1.5">
            <input class="split-total" type="text" inputmode="numeric" placeholder="金額" value="${esc(row.total)}" style="margin:0" oninput="updateSplitPreview()">
          </div>
          ${removeBtn}
        </div>
      `;
    }).join('');

    openModal(`<h2>拆分進貨</h2>
      <datalist id="modelList">${MODELS.map(m => `<option value="${esc(m)}">`).join('')}</datalist>
      <div id="split_rows_container">${rowsHtml}</div>
      <button class="btn" style="width:100%;margin-bottom:16px;min-height:44px;" onclick="addSplitRow(event)">＋ 加一行</button>
      <div class="preview" id="split_preview" style="background:#f2f3f8;color:var(--mut);margin-bottom:16px;padding:10px;border-radius:4px"></div>
      <div class="form-actions">
        <button class="btn" onclick="cancelSplit()">取消</button>
        <button class="btn primary" id="split_confirm" onclick="submitSplit()">確認拆單</button>
      </div>`);
      
    updateSplitPreview();
  };

  window.updateSplitPreview = () => {
    let sum = 0;
    const rows = document.querySelectorAll('.split-row-item');
    rows.forEach(r => {
      const totalInp = r.querySelector('.split-total');
      if (totalInp) {
        sum += (+totalInp.value || 0);
      }
    });
    const previewDiv = $('#split_preview');
    if (previewDiv) {
      const diffText = sum !== p.total ? `，不相符—請確認` : '';
      previewDiv.innerHTML = `各筆金額合計 ${sum}（原金額 ${p.total}${diffText}）`;
    }
  };

  window.addSplitRow = (e) => {
    if (e) e.preventDefault();
    syncSplitFromDOM();
    if (splitRows.length >= 12) {
      alert("最多只能新增 12 行");
      return;
    }
    splitRows.push({ model: '', qty: '', total: '' });
    renderSplitForm();
  };

  window.removeSplitRow = (idx) => {
    syncSplitFromDOM();
    splitRows.splice(idx, 1);
    renderSplitForm();
  };

  window.cancelSplit = () => {
    openPurchaseEditForm(id);
  };

  window.submitSplit = async () => {
    syncSplitFromDOM();
    for (const item of splitRows) {
      const qtyVal = +item.qty || 0;
      const totalVal = item.total === '' ? -1 : (+item.total || 0);
      if (!item.model || qtyVal < 1 || totalVal < 0) {
        alert("型號、台數、金額格式不正確");
        return;
      }
    }

    const confirmBtn = $('#split_confirm');
    if (confirmBtn && confirmBtn.disabled) return;
    if (confirmBtn) confirmBtn.disabled = true;
    
    try {
      await api(`/api/purchase/${id}/split`, {
        body: {
          items: splitRows.map(r => ({
            model: r.model,
            qty: +r.qty || 0,
            total: +r.total || 0
          }))
        }
      });
      closeModal();
      await load();
    } finally {
      if (confirmBtn) confirmBtn.disabled = false;
    }
  };

  renderSplitForm();
}
async function submitPurchaseEdit(id) {
  const inputs = [...document.querySelectorAll('.pe-serial')];
  for (const inp of inputs) {
    if (!inp.value.trim()) {
      alert('貨號不可空白');
      return;
    }
  }
  const newSerials = inputs.map(inp => inp.value.trim());
  const seen = new Set();
  for (const s of newSerials) {
    if (seen.has(s)) {
      alert('貨號重複：' + s);
      return;
    }
    seen.add(s);
  }
  const saveBtn = $('#pe_save');
  if (saveBtn && saveBtn.disabled) return;
  if (saveBtn) saveBtn.disabled = true;
  try {
    const serials = {};
    for (const inp of inputs) {
      const uid = +inp.dataset.uid;
      const val = inp.value.trim();
      const u = D.units.find(x => x.id === uid);
      if (u && val !== u.serial) {
        serials[uid] = val;
      }
    }
    const body = {
      date: $('#f_date').value,
      model: $('#f_model').value.trim(),
      total: +$('#f_total').value || 0,
      note: $('#f_note').value.trim()
    };
    if ($('#f_qty')) body.qty = +$('#f_qty').value || 0;
    if (Object.keys(serials).length > 0) {
      body.serials = serials;
    }
    await api('/api/purchase/' + id, {
      method: 'PATCH',
      body: body
    });
    closeModal();
    await load();
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}
function openPurchaseForm() {
  openModal(`<h2>新增進貨</h2>
    <div class="two">
      <div class="field"><label>日期</label><input id="f_date" type="date" value="${today()}"></div>
      <div class="field"><label>入庫類型</label><div class="seg" id="f_ptype"></div></div>
    </div>
    <div id="f_blocks_container"></div>
    <button class="btn" style="width:100%;margin-bottom:16px;min-height:44px;" onclick="addPurchaseBlock(event)">＋ 加另一個型號</button>
    <div class="field"><label>備註（選填）</label><input id="f_note" placeholder="供應商、發票號碼…"></div>
    <div class="form-actions">
      <button class="btn" onclick="closeModal()">取消</button>
      <button class="btn primary" id="p_save" onclick="submitPurchase()">儲存</button>
    </div>`);

  let ptype = 'in_stock';
  let blocks = [
    { model: 'High Grade', qty: 1, total: '', serials: [''] }
  ];

  const renderPtype = () => {
    $('#f_ptype').innerHTML =
      `<button class="${ptype === 'in_stock' ? 'on' : ''}" data-t="in_stock">一般庫存</button>` +
      `<button class="${ptype === 'trial' ? 'on' : ''}" data-t="trial">試用機 🧪</button>`;
    $('#f_ptype').querySelectorAll('button').forEach(b => b.onclick = () => { ptype = b.dataset.t; renderPtype(); });
  };

  const syncFromDOM = () => {
    blocks.forEach((b, idx) => {
      const qtyInp = $(`#f_qty_${idx}`);
      if (qtyInp) {
        b.qty = Math.max(1, Math.min(50, +qtyInp.value || 1));
      }
      const totalInp = $(`#f_total_${idx}`);
      if (totalInp) {
        b.total = totalInp.value;
      }
      const blockSerialsDiv = $(`#f_serials_${idx}`);
      if (blockSerialsDiv) {
        b.serials = [...blockSerialsDiv.querySelectorAll('.serial-in')].map(i => i.value);
      }
    });
  };

  const renderBlocks = () => {
    const container = $('#f_blocks_container');
    container.innerHTML = blocks.map((b, idx) => {
      const removeBtn = idx > 0 ? `<button class="btn" style="min-height:44px;padding:4px 12px;font-size:14px;margin:0" onclick="removePurchaseBlock(${idx})">✕ 移除</button>` : '';
      const header = blocks.length > 1 ? `
        <div class="block-header" style="display:flex;align-items:center;justify-content:space-between;margin-top:15px;margin-bottom:8px">
          <h2 class="section" style="margin:0">型號 ${idx + 1}</h2>
          ${removeBtn}
        </div>
      ` : '';
      const blockStyle = blocks.length > 1 ? 'border-bottom:1px solid #eee;padding-bottom:15px;margin-bottom:15px' : '';
      
      return `
        <div class="purchase-block" style="${blockStyle}">
          ${header}
          <div class="field"><label>型號</label><div class="seg" id="f_models_${idx}"></div></div>
          <div class="two">
            <div class="field"><label>數量</label><input id="f_qty_${idx}" type="text" inputmode="numeric" value="${b.qty}" oninput="updateQty(${idx}, this.value)"></div>
            <div class="field"><label>金額（此型號總額）</label><input id="f_total_${idx}" type="text" inputmode="numeric" placeholder="0" value="${esc(b.total || '')}"></div>
          </div>
          <div class="field">
            <label>貨號（每台一個）<button class="btn" style="min-height:34px;padding:4px 12px;font-size:14px;margin-left:8px" onclick="autoSerialsBlock(${idx})">自動產生</button></label>
            <div id="f_serials_${idx}">
              ${Array.from({ length: b.qty }, (_, i) =>
                `<input class="serial-in" style="margin-bottom:8px" placeholder="第 ${i + 1} 台貨號" value="${esc(b.serials[i] || '')}">`
              ).join('')}
            </div>
          </div>
        </div>
      `;
    }).join('');

    blocks.forEach((b, idx) => {
      const segDiv = $(`#f_models_${idx}`);
      if (segDiv) {
        segDiv.innerHTML = MODELS.map(mo =>
          `<button class="${mo === b.model ? 'on' : ''}" data-m="${esc(mo)}">${esc(mo)}</button>`
        ).join('');
        segDiv.querySelectorAll('button').forEach(btn => {
          btn.onclick = () => {
            syncFromDOM();
            blocks[idx].model = btn.dataset.m;
            renderBlocks();
          };
        });
      }
    });
  };

  window._pType = () => ptype;
  window.updateQty = (idx, val) => {
    const qty = Math.max(1, Math.min(50, +val || 1));
    blocks[idx].qty = qty;
    const blockSerialsDiv = $(`#f_serials_${idx}`);
    if (blockSerialsDiv) {
      const inputs = [...blockSerialsDiv.querySelectorAll('.serial-in')].map(i => i.value);
      const newSerials = Array.from({ length: qty }, (_, i) => inputs[i] || '');
      blocks[idx].serials = newSerials;
      blockSerialsDiv.innerHTML = newSerials.map((s, i) =>
        `<input class="serial-in" style="margin-bottom:8px" placeholder="第 ${i + 1} 台貨號" value="${esc(s)}">`
      ).join('');
    }
  };

  window.autoSerialsBlock = (idx) => {
    syncFromDOM();
    const d = ($('#f_date').value || today()).replaceAll('-', '').slice(2);
    const t = ptype === 'trial' ? 'T' : '';
    let startNum = 1;
    for (let i = 0; i < idx; i++) {
      startNum += blocks[i].qty;
    }
    const b = blocks[idx];
    const blockSerialsDiv = $(`#f_serials_${idx}`);
    if (blockSerialsDiv) {
      const inputs = blockSerialsDiv.querySelectorAll('.serial-in');
      inputs.forEach((inp, i) => {
        inp.value = `${PREFIX[b.model] || 'XX'}${d}-${t}${startNum + i}`;
      });
    }
  };

  window.addPurchaseBlock = (e) => {
    if (e) e.preventDefault();
    syncFromDOM();
    if (blocks.length >= 10) {
      alert("最多只能新增 10 個型號");
      return;
    }
    blocks.push({
      model: 'High Grade',
      qty: 1,
      total: '',
      serials: ['']
    });
    renderBlocks();
  };

  window.removePurchaseBlock = (idx) => {
    syncFromDOM();
    blocks.splice(idx, 1);
    renderBlocks();
  };

  window.submitPurchase = async () => {
    syncFromDOM();
    for (let idx = 0; idx < blocks.length; idx++) {
      const totalInp = $(`#f_total_${idx}`);
      if (!totalInp || !totalInp.value.trim()) {
        alert("金額（總額）為必填");
        return;
      }
    }
    
    for (let idx = 0; idx < blocks.length; idx++) {
      const blockSerialsDiv = $(`#f_serials_${idx}`);
      if (blockSerialsDiv) {
        const inputs = blockSerialsDiv.querySelectorAll('.serial-in');
        for (const inp of inputs) {
          if (!inp.value.trim()) {
            alert("貨號不可空白");
            return;
          }
        }
      }
    }

    const allSerials = [];
    for (let idx = 0; idx < blocks.length; idx++) {
      const blockSerialsDiv = $(`#f_serials_${idx}`);
      if (blockSerialsDiv) {
        const inputs = blockSerialsDiv.querySelectorAll('.serial-in');
        for (const inp of inputs) {
          const val = inp.value.trim();
          if (allSerials.includes(val)) {
            alert("貨號重複：" + val);
            return;
          }
          allSerials.push(val);
        }
      }
    }

    const saveBtn = $('#p_save');
    if (saveBtn && saveBtn.disabled) return;
    if (saveBtn) saveBtn.disabled = true;
    try {
      await api('/api/purchase', {
        body: {
          date: $('#f_date').value,
          status: ptype,
          note: $('#f_note').value.trim(),
          items: blocks.map((b, idx) => ({
            model: b.model,
            total: +b.total || 0,
            serials: b.serials.map(s => s.trim())
          }))
        }
      });
      closeModal();
      await load();
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
  };

  renderPtype();
  renderBlocks();
}

/* ---------- trials ---------- */
const rentBadge = type => {
  if (type === 'week7') return ' <span class="badge warn">七天租</span>';
  if (type === 'month') return ' <span class="badge">月租</span>';
  if (type === 'franchise') return ' <span class="badge ok">特許租用</span>';
  if (type === 'hq') return ' <span class="badge mut">總部月租</span>';
  if (type === 'reserve') return ' <span class="badge res">預約</span>';
  return '';
};

function viewTrials() {
  const searchInput = `<input type="search" class="page-search" placeholder="搜尋…" value="${esc(SEARCH.trials)}" oninput="setSearch('trials', this.value)">`;

  let filteredTrials = D.trials;
  if (SEARCH.trials) {
    const q = SEARCH.trials.toLowerCase();
    filteredTrials = filteredTrials.filter(t =>
      (t.customer || '').toLowerCase().includes(q) ||
      (t.model || '').toLowerCase().includes(q) ||
      (t.note || '').toLowerCase().includes(q)
    );
  }

  const active = filteredTrials.filter(t => !t.returned);
  const done = filteredTrials.filter(t => t.returned);
  const now = today();

  const item = t => {
    let due = '';
    if (!t.returned) {
      if (t.rent_type === 'reserve') {
        if (t.start_date) {
          due = `<span class="badge">${t.start_date.slice(5)} 起</span>`;
        }
      } else if (t.end_date) {
        const days = Math.ceil((new Date(t.end_date) - new Date(now)) / 86400000);
        due = days < 0 ? `<span class="badge bad">逾期 ${-days} 天</span>`
          : days <= 3 ? `<span class="badge warn">剩 ${days} 天</span>`
          : `<span class="badge ok">剩 ${days} 天</span>`;
      }
    }
    const badgeHtml = rentBadge(t.rent_type || '');
    let btnHtml = '';
    if (t.returned) {
      btnHtml = '<span class="badge mut">已歸還</span>';
    } else if (t.rent_type === 'reserve') {
      btnHtml = `<button class="btn primary" onclick="event.stopPropagation();openStartRentForm(${t.id})">開始</button>`;
    } else {
      btnHtml = `<button class="btn" onclick="event.stopPropagation();returnTrial(${t.id})">歸還</button>`;
    }

    let subLine = `${t.start_date || '？'} ～ ${t.end_date || '？'}`;
    if (t.returned && t.return_date) {
      subLine += `｜${t.return_date.slice(5)} 歸還`;
    }
    if (t.note) {
      subLine += `｜${esc(t.note)}`;
    }

    return `<div class="card row" onclick="openTrialEditForm(${t.id})" style="cursor:pointer">
      <div class="grow">
        <div class="title">${esc(t.customer) || '—'} ${t.model ? `<span class="badge">${esc(t.model)}</span>` : ''}${badgeHtml} ${due}</div>
        <div class="sub">${subLine}</div>
      </div>
      ${btnHtml}
      <button class="icon-btn" onclick="event.stopPropagation();delTrial(${t.id})">🗑</button>
    </div>`;
  };

  const reserves = active.filter(t => t.rent_type === 'reserve');
  reserves.sort((a, b) => {
    const sA = a.start_date || '';
    const sB = b.start_date || '';
    if (!sA && !sB) return 0;
    if (!sA) return 1;
    if (!sB) return -1;
    return sA.localeCompare(sB);
  });

  const direct = active.filter(t => t.rent_type === 'week7' || t.rent_type === 'month' || !t.rent_type);
  const rentTypeOrder = { week7: 0, month: 1, '': 2 };
  direct.sort((a, b) => {
    const oA = rentTypeOrder[a.rent_type || ''] ?? 2;
    const oB = rentTypeOrder[b.rent_type || ''] ?? 2;
    return oA - oB;
  });

  const franchise = active.filter(t => t.rent_type === 'franchise');
  const hq = active.filter(t => t.rent_type === 'hq');

  let html = '';
  if (!D.trials.length) {
    html = '<div class="empty">尚無試用紀錄，按＋新增</div>';
  } else if (!filteredTrials.length) {
    html = '<div class="empty">無符合搜尋的試用紀錄</div>';
  } else {
    if (active.length === 0) {
      html += '<div class="empty">無進行中的試用</div>';
    } else {
      if (direct.length > 0) {
        html += `<h2 class="section">直租（七天租／月租）（${direct.length}）</h2>` + direct.map(item).join('');
      }
      if (franchise.length > 0) {
        html += `<h2 class="section">特許租用（${franchise.length}）</h2>` + franchise.map(item).join('');
      }
      if (hq.length > 0) {
        html += `<h2 class="section">總部月租（${hq.length}）</h2>` + hq.map(item).join('');
      }
      if (reserves.length > 0) {
        html += `<h2 class="section">預約（${reserves.length}）</h2>` + reserves.map(item).join('');
      }
    }
    if (done.length > 0) {
      html += `<h2 class="section">已歸還（${done.length}）</h2>` + done.map(item).join('');
    }
  }

  return searchInput + html;
}
window.doReturnTrial = async (id) => {
  const btn = $('#confirmReturnBtn');
  if (btn.disabled) return;
  btn.disabled = true;
  try {
    const return_date = $('#ret_date').value;
    await api(`/api/trial/${id}/return`, {
      body: { return_date }
    });
    closeModal();
    await load();
  } catch (e) {
    btn.disabled = false;
  }
};
function returnTrial(id) {
  const t = D.trials.find(x => x.id === id);
  if (!t) return;
  openModal(`<h2>確認歸還</h2>
    <div style="margin-bottom:14px;font-size:16px;color:var(--ink);font-weight:600">客戶：${esc(t.customer)}　型號：${esc(t.model)}</div>
    <div class="field">
      <label for="ret_date">歸還日</label>
      <input id="ret_date" type="date" value="${today()}">
    </div>
    <div class="form-actions">
      <button class="btn" onclick="closeModal()">取消</button>
      <button class="btn primary" id="confirmReturnBtn" onclick="doReturnTrial(${id})">確認歸還</button>
    </div>`);
}
function openStartRentForm(id) {
  const t = D.trials.find(x => x.id === id);
  if (!t) return;
  const plus30 = new Date(Date.now() + 30 * 86400000).toLocaleDateString('sv-SE');
  openModal(`<h2>開始租借</h2>
    <div class="field"><label>客戶</label><div style="font-weight:bold; font-size:18px; padding: 4px 0;">${esc(t.customer)}</div></div>
    <div class="field"><label>租類</label><div class="seg" id="f_renttype">
      <button data-t="week7">七天租</button>
      <button class="on" data-t="month">月租</button>
      <button data-t="franchise">特許租用</button>
    </div></div>
    <div class="two">
      <div class="field"><label>開始</label><input id="f_start" type="date" value="${today()}"></div>
      <div class="field"><label>結束</label><input id="f_end" type="date" value="${plus30}"></div>
    </div>
    <div class="form-actions">
      <button class="btn" onclick="closeModal()">取消</button>
      <button class="btn primary" onclick="submitStartRent(${t.id})">開始租借</button>
    </div>`);
  
  let rentType = 'month';
  let endTouched = false;

  const updateEndDate = () => {
    if (endTouched) return;
    const startVal = $('#f_start').value;
    if (!startVal) return;
    const parts = startVal.split('-');
    if (parts.length !== 3) return;
    const d = new Date(parts[0], parts[1] - 1, parts[2]);
    const days = rentType === 'week7' ? 7 : 30;
    d.setDate(d.getDate() + days);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    $('#f_end').value = `${y}-${m}-${day}`;
  };

  $('#f_start').oninput = updateEndDate;
  $('#f_end').oninput = () => {
    endTouched = $('#f_end').value !== '';
  };

  $('#f_renttype').querySelectorAll('button').forEach(b => b.onclick = () => {
    rentType = b.dataset.t;
    $('#f_renttype').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    updateEndDate();
  });

  window._srRentType = () => rentType;
}
async function submitStartRent(id) {
  await api('/api/trial/' + id, {
    method: 'PATCH',
    body: {
      rent_type: window._srRentType(),
      start_date: $('#f_start').value,
      end_date: $('#f_end').value
    }
  });
  closeModal(); await load();
}


function openTrialEditForm(id) {
  const t = D.trials.find(x => x.id === id);
  if (!t) return;
  openModal(`<h2>編輯試用 / 出租</h2>
    <div class="field"><label>租類</label><div class="seg" id="f_renttype">
      <button data-t="week7">七天租</button>
      <button data-t="month">月租</button>
      <button data-t="franchise">特許租用</button>
      <button data-t="hq">總部月租</button>
      <button data-t="reserve">預約</button>
    </div></div>
    <div class="field"><label>人名</label><input id="f_cust" list="custList" value="${esc(t.customer)}">
      <datalist id="custList">${D.customers.map(c => `<option value="${esc(c)}">`).join('')}</datalist></div>
    <div class="field"><label>型號</label><div class="seg" id="f_models"></div></div>
    <div class="two">
      <div class="field"><label>開始</label><input id="f_start" type="date" value="${t.start_date}"></div>
      <div class="field"><label>結束</label><input id="f_end" type="date" value="${t.end_date}"></div>
    </div>
    <div class="two">
      <div class="field"><label>狀態</label><div class="seg" id="f_tstatus"></div></div>
      <div class="field"><label>歸還日（已歸還時）</label><input id="f_retdate" type="date" value="${t.return_date || ''}"></div>
    </div>
    <div class="field"><label>備註</label><input id="f_note" value="${esc(t.note)}"></div>
    <div class="form-actions">
      <button class="btn" onclick="closeModal()">取消</button>
      <button class="btn primary" onclick="submitTrialEdit(${t.id})">儲存</button>
    </div>`);
  let model = t.model;
  let returned = !!t.returned;
  let rentType = t.rent_type || '';
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
  const renderRentTypes = () => {
    $('#f_renttype').querySelectorAll('button').forEach(b => {
      b.classList.toggle('on', b.dataset.t === rentType);
    });
  };
  $('#f_renttype').querySelectorAll('button').forEach(b => b.onclick = () => {
    rentType = b.dataset.t;
    renderRentTypes();
  });
  renderModels(); renderStatus(); renderRentTypes();
  window._teModel = () => model;
  window._teReturned = () => returned;
  window._teRentType = () => rentType;
}
async function submitTrialEdit(id) {
  const saveBtn = $('#modalCard button.primary');
  if (saveBtn) saveBtn.disabled = true;
  try {
    await api('/api/trial/' + id, {
      method: 'PATCH',
      body: {
        customer: $('#f_cust').value.trim(), model: window._teModel(),
        start_date: $('#f_start').value, end_date: $('#f_end').value,
        note: $('#f_note').value.trim(), returned: window._teReturned() ? 1 : 0,
        rent_type: window._teRentType(),
        return_date: $('#f_retdate').value
      }
    });
    closeModal(); await load();
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}
async function delTrial(id) {
  if (!confirm('刪除此筆試用紀錄？')) return;
  await api('/api/trial/' + id, { method: 'DELETE' }); await load();
}
function openTrialForm() {
  const plus30 = new Date(Date.now() + 30 * 86400000).toLocaleDateString('sv-SE');
  openModal(`<h2>新增試用 / 出租</h2>
    <div class="field"><label>租類</label><div class="seg" id="f_renttype">
      <button data-t="week7">七天租</button>
      <button class="on" data-t="month">月租</button>
      <button data-t="franchise">特許租用</button>
      <button data-t="hq">總部月租</button>
      <button data-t="reserve">預約</button>
    </div></div>
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
      <button class="btn primary" id="t_save" onclick="submitTrial()">儲存</button>
    </div>`);
  let model = 'Standard';
  let rentType = 'month';
  let startTouched = false;
  let endTouched = false;

  const updateEndDate = () => {
    if (endTouched) return;
    if (rentType === 'reserve') {
      $('#f_end').value = '';
      return;
    }
    const startVal = $('#f_start').value;
    if (!startVal) return;
    const parts = startVal.split('-');
    if (parts.length !== 3) return;
    const d = new Date(parts[0], parts[1] - 1, parts[2]);
    const days = rentType === 'week7' ? 7 : 30;
    d.setDate(d.getDate() + days);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    $('#f_end').value = `${y}-${m}-${day}`;
  };

  $('#f_start').oninput = () => {
    startTouched = $('#f_start').value !== '';
    updateEndDate();
  };
  $('#f_end').oninput = () => {
    endTouched = $('#f_end').value !== '';
  };

  $('#f_renttype').querySelectorAll('button').forEach(b => b.onclick = () => {
    const prevType = rentType;
    rentType = b.dataset.t;
    $('#f_renttype').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    if (rentType === 'reserve') {
      $('#f_start').value = '';
      $('#f_end').value = '';
      startTouched = endTouched = false;
    } else if (prevType === 'reserve') {
      if (!$('#f_start').value) {
        $('#f_start').value = today();
        startTouched = false;
      }
    }
    updateEndDate();
  });

  const renderModels = () => {
    $('#f_models').innerHTML = MODELS.map(mo =>
      `<button class="${mo === model ? 'on' : ''}" data-m="${esc(mo)}">${esc(mo)}</button>`).join('');
    $('#f_models').querySelectorAll('button').forEach(b => b.onclick = () => { model = b.dataset.m; renderModels(); });
  };
  renderModels();
  window._tModel = () => model;
  window._tRentType = () => rentType;
}
async function submitTrial() {
  const saveBtn = $('#t_save');
  if (saveBtn && saveBtn.disabled) return;
  if (saveBtn) saveBtn.disabled = true;
  try {
  await api('/api/trial', {
    body: {
      customer: $('#f_cust').value.trim(), model: window._tModel(),
      start_date: $('#f_start').value, end_date: $('#f_end').value,
      note: $('#f_note').value.trim(), rent_type: window._tRentType()
    }
  });
  closeModal(); await load();
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

/* ---------- stock ---------- */
let stockFilter = 'active';
function viewStock() {
  const searchInput = `<input type="search" class="page-search" placeholder="搜尋…" value="${esc(SEARCH.stock)}" oninput="setSearch('stock', this.value)">`;

  let filteredUnits = D.units;
  if (SEARCH.stock) {
    const q = SEARCH.stock.toLowerCase();
    filteredUnits = filteredUnits.filter(u =>
      (u.serial || '').toLowerCase().includes(q) ||
      (u.model || '').toLowerCase().includes(q) ||
      (u.note || '').toLowerCase().includes(q)
    );
  }

  const counts = {};
  MODELS.forEach(mo => {
    counts[mo] = {
      stock: filteredUnits.filter(u => u.model === mo && u.status === 'in_stock').length,
      trial: filteredUnits.filter(u => u.model === mo && u.status === 'trial').length,
      consigned: filteredUnits.filter(u => u.model === mo && u.status === 'consigned').length
    };
  });
  const chips = MODELS.filter(mo => counts[mo].stock + counts[mo].trial + counts[mo].consigned > 0 || filteredUnits.some(u => u.model === mo)).map(mo =>
    `<div class="chip-card"><div class="num">${counts[mo].stock}</div>
     <div class="lbl">${esc(mo)}${counts[mo].trial ? `（＋試用 ${counts[mo].trial}）` : ''}${counts[mo].consigned ? `（＋特許 ${counts[mo].consigned}）` : ''}</div></div>`).join('');

  const filters = [
    ['active', '可售（在庫）'],
    ['out', '外出中（試用＋特許）'],
    ['sold', '已售／除役'],
    ['all', '全部']
  ].map(([k, l]) =>
    `<button class="${stockFilter === k ? 'on' : ''}" onclick="setStockFilter('${k}')">${l}</button>`).join('');

  const units = filteredUnits.filter(u =>
    stockFilter === 'all' ? true :
    stockFilter === 'active' ? u.status === 'in_stock' :
    stockFilter === 'out' ? (u.status === 'trial' || u.status === 'consigned') :
    stockFilter === 'sold' ? (u.status === 'sold' || u.status === 'retired') :
    true
  );

  const badge = u => {
    const cls = { in_stock: 'ok', trial: 'warn', sold: 'mut', retired: 'bad', consigned: 'warn' }[u.status];
    return `<span class="badge ${cls}">${STATUS_LABEL[u.status]}</span>`;
  };

  return searchInput + `<div class="chips">${chips}</div>
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
let taxYear = null;
window._taxYear = y => {
  taxYear = y;
  render();
};
window.downloadTaxXlsx = () => {
  location.href = '/api/tax-export.xlsx?year=' + (taxYear || new Date().getFullYear());
};

function viewReport() {
  let html = '';
  if (!D.monthly.length) {
    html = '<div class="empty">尚無資料</div>';
  } else {
    const reportPeriodSeg = `<div class="seg" style="margin-bottom:12px">
      <button class="${reportPeriod === 'm12' ? 'on' : ''}" onclick="setReportPeriod('m12')">近12個月</button>
      <button class="${reportPeriod === 'all' ? 'on' : ''}" onclick="setReportPeriod('all')">全部</button>
    </div>`;

    let rows = D.monthly;
    if (reportPeriod === 'm12') {
      rows = rows.slice(-12);
    }

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
    html = reportPeriodSeg + `<div class="chart-card">
        <div class="legend"><span><span class="dot" style="background:#3b4a9f"></span>銷售</span>
        <span><span class="dot" style="background:#1a8f5c"></span>毛利</span></div>
        <svg viewBox="0 0 ${W} ${H}" style="width:100%">${bars}</svg>
      </div>
      <div class="table-scroll">
      <table>
        <tr><th>月份</th><th>銷售總額</th><th>成本</th>${hasCommission ? '<th>佣金</th>' : ''}${hasExtra ? '<th>其他費用</th>' : ''}<th>毛利</th><th>台數</th><th>毛利率</th></tr>
        ${rows.map(r => `<tr><td>${r.ym}</td><td>${fmt(r.revenue)}</td><td>${fmt(r.cost)}</td>${hasCommission ? `<td>${fmt(r.commission)}</td>` : ''}${hasExtra ? `<td>${fmt(r.extra)}</td>` : ''}
          <td class="${r.profit >= 0 ? 'pos' : 'neg'}">${fmt(r.profit)}</td><td>${r.qty}</td>
          <td>${r.revenue ? (r.profit / r.revenue * 100).toFixed(1) : '0.0'}%</td></tr>`).join('')}
        <tr class="total"><td>合計</td><td>${fmt(tot.revenue)}</td><td>${fmt(tot.cost)}</td>${hasCommission ? `<td>${fmt(tot.commission)}</td>` : ''}${hasExtra ? `<td>${fmt(tot.extra)}</td>` : ''}
          <td>${fmt(tot.profit)}</td><td>${tot.qty}</td>
          <td>${tot.revenue ? (tot.profit / tot.revenue * 100).toFixed(1) : '0.0'}%</td></tr>
      </table>
      </div>`;
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
  }

  const currentYear = new Date().getFullYear();
  if (taxYear === null) {
    taxYear = currentYear;
  }
  const yearsSet = new Set([currentYear]);
  if (D.sales) {
    D.sales.forEach(s => {
      if (s.sale_type === 'franchise' && s.settled && s.settle_date) {
        const y = parseInt(s.settle_date.slice(0, 4));
        if (y >= 2000 && y <= 2100) {
          yearsSet.add(y);
        }
      }
    });
  }
  const years = Array.from(yearsSet).sort((a, b) => b - a).slice(0, 5);
  const segButtons = years.map(y =>
    `<button class="${taxYear === y ? 'on' : ''}" onclick="window._taxYear(${y})">${y}（${y - 1911}年度）</button>`
  ).join('');

  html += `<h2 class="section">報稅匯出</h2>
  <div class="card">
    <div class="field"><label>年度（依結清日）</label><div class="seg" id="r_taxyear">${segButtons}</div></div>
    <button class="btn primary" style="width:100%" onclick="downloadTaxXlsx()">⬇ 下載執行業務所得清冊</button>
  </div>`;

  return html;
}

/* ---------- boot ---------- */
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
load().catch(() => showLogin());
