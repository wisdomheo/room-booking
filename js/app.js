/* 화면 흐름: 로그인 → 시간표 → (예약 / 내 예약 바꾸기·취소 / 관리자 기능) */
'use strict';

const $ = s => document.querySelector(s);
const WD = ['일', '월', '화', '수', '목', '금', '토'];
const pad = n => String(n).padStart(2, '0');
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SESSION_KEY = 'rsv.session';
const LAST_NAME_KEY = 'rsv.lastName';

const S = {
  session: null,     // { token, name, isAdmin }
  staff: [],
  date: Core.nowKST().date,
  cache: null,       // { from, to, items: [] }
  loading: false
};

/* ---------- 작은 도구 ---------- */
function store(key, val) {
  try { if (val === undefined) return JSON.parse(localStorage.getItem(key)); if (val === null) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(val)); }
  catch (e) { return null; }
}
function dateLabel(d) { const t = Core.parseDate(d); return `${t.getUTCMonth() + 1}월 ${t.getUTCDate()}일 (${WD[t.getUTCDay()]})`; }
function hourLabel(h) { return `${pad(h)}:00–${pad(h + 1)}:00`; }
let toastTimer = null;
function toast(msg, isErr) {
  const el = $('#toast');
  el.textContent = msg; el.className = 'toast' + (isErr ? ' err' : ''); el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, isErr ? 4500 : 2500);
}
function show(id) { ['#login', '#main'].forEach(s => { $(s).hidden = s !== id; }); }
function openSheet(html) { $('#sheetBody').innerHTML = html; $('#sheet').hidden = false; }
function closeSheet() { $('#sheet').hidden = true; $('#sheetBody').innerHTML = ''; }
function sheetMsg(msg) { const el = $('#sheetBody .msg'); if (el) el.textContent = msg; }

/* 서버 오류 공통 처리: 로그인 만료면 로그인 화면으로 */
function handleErr(e, where) {
  if (e.code === 'auth') { logout(); $('#loginMsg').textContent = e.message; return; }
  if (where === 'sheet' && !$('#sheet').hidden) sheetMsg(e.message); else toast(e.message, true);
}

/* ---------- 로그인 ---------- */
async function loadStaff() {
  const sel = $('#loginName');
  try {
    const res = await Api.call('staff');
    S.staff = res.staff;
    if (!S.staff.length) { sel.innerHTML = '<option value="">명단이 비어 있어요</option>'; $('#loginMsg').textContent = '관리자가 구글 시트의 직원 탭에 이름을 적어야 해요.'; return; }
    const last = store(LAST_NAME_KEY);
    sel.innerHTML = '<option value="">이름을 고르세요</option>' +
      S.staff.map(s => `<option value="${esc(s.name)}"${s.name === last ? ' selected' : ''}>${esc(s.name)}</option>`).join('');
    onNamePick();
  } catch (e) {
    sel.innerHTML = '<option value="">불러오지 못했어요</option>';
    $('#loginMsg').textContent = e.message;
  }
}
function pickedStaff() { return S.staff.find(s => s.name === $('#loginName').value) || null; }
function onNamePick() {
  const s = pickedStaff();
  const isNew = !!s && !s.hasPin;
  $('#pin2Row').hidden = !isNew;
  $('#loginHint').textContent = !s ? '' : s.locked ? '🔒 잠긴 상태예요. 관리자에게 비밀번호 초기화를 요청해 주세요.'
    : isNew ? '처음 사용(또는 초기화됨): 앞으로 쓸 비밀번호 4자리를 정해 주세요.' : '';
  $('#loginBtn').textContent = isNew ? '비밀번호 정하고 시작하기' : '시작하기';
  $('#loginMsg').textContent = '';
}
async function login() {
  const s = pickedStaff(), pin = $('#pin1').value.trim(), msg = $('#loginMsg');
  if (!s) { msg.textContent = '이름을 골라 주세요.'; return; }
  if (!/^\d{4}$/.test(pin)) { msg.textContent = '비밀번호는 숫자 4자리예요.'; return; }
  if (!s.hasPin && pin !== $('#pin2').value.trim()) { msg.textContent = '두 번 입력한 비밀번호가 달라요.'; return; }
  const btn = $('#loginBtn'); btn.disabled = true; msg.textContent = '';
  try {
    const res = await Api.call('login', { name: s.name, pin });
    S.session = { token: res.token, name: res.name, isAdmin: res.isAdmin };
    store(SESSION_KEY, S.session); store(LAST_NAME_KEY, s.name);
    $('#pin1').value = ''; $('#pin2').value = '';
    enterMain();
  } catch (e) {
    if (e.code === 'locked' || e.code === 'badpin') { $('#pin1').value = ''; await loadStaff(); }   // 잠김 표시 갱신
    msg.textContent = e.message;
  } finally { btn.disabled = false; }
}
function logout() {
  S.session = null; S.cache = null; store(SESSION_KEY, null);
  closeSheet(); show('#login'); $('#loginDemo').hidden = !Api.demo; loadStaff();
}

/* ---------- 시간표 ---------- */
function enterMain() {
  $('#who').textContent = S.session.name + (S.session.isAdmin ? ' · 관리자' : '') + ' ▾';
  $('#demoBanner').hidden = !Api.demo;
  S.date = Core.nowKST().date;
  show('#main');
  load(true);
}
function inCache(d) { return S.cache && d >= S.cache.from && d <= S.cache.to; }
async function load(force) {
  const date = S.date;
  if (!force && inCache(date)) { render(); return; }
  if (!inCache(date)) { S.cache = null; render(); }
  const from = date, to = Core.addDays(date, 6);
  try {
    S.loading = true;
    const res = await Api.call('list', { token: S.session.token, from, to });
    if (S.date < from || S.date > to) return;    // 그 사이에 다른 날짜로 옮겨 간 경우
    S.cache = { from, to, items: res.bookings };
  } catch (e) { handleErr(e); }
  finally { S.loading = false; if (S.session) render(); }
}
function bookingAt(date, hour, room) {
  return S.cache ? S.cache.items.find(b => b.date === date && b.hour === hour && b.room === room) : null;
}
function render() {
  const d = S.date, today = Core.nowKST().date;
  $('#dateText').innerHTML = esc(dateLabel(d)) + (d === today ? '<span class="badge">오늘</span>' : '');
  $('#datePicker').value = d;
  const grid = $('#grid');
  const hours = Core.hoursFor(d);
  if (!hours.length) { grid.innerHTML = '<div class="closed-day">일요일은 예약할 수 없어요.</div>'; return; }
  if (!inCache(d)) { grid.innerHTML = '<div class="loading">시간표를 불러오는 중…</div>'; return; }
  const head = '<tr><th class="time"></th>' + Core.ROOMS.map(r => `<th>${esc(r.short)}</th>`).join('') + '</tr>';
  const rows = hours.map(h => '<tr><th class="time">' + pad(h) + '시</th>' + Core.ROOMS.map(r => {
    const b = bookingAt(d, h, r.id);
    const st = Core.slotStatus(d, h, r.id);
    const label = `${r.name} ${hourLabel(h)}`;
    if (b) {
      const mine = b.owner === S.session.name;
      return `<td><button class="cell booked${mine ? ' mine' : ''}${st === 'past' ? ' past' : ''}" data-act="cell" data-hour="${h}" data-room="${r.id}"
        aria-label="${esc(label)} ${esc(b.owner)} ${esc(b.purpose)}"><span class="owner">${esc(b.owner)}</span><span class="purpose">${esc(b.purpose)}</span></button></td>`;
    }
    if (st === 'ok') return `<td><button class="cell free" data-act="cell" data-hour="${h}" data-room="${r.id}" aria-label="${esc(label)} 비어 있음, 예약하기"><span class="plus">+</span></button></td>`;
    return `<td><button class="cell off" data-act="cell" data-hour="${h}" data-room="${r.id}" aria-label="${esc(label)} 예약 불가"></button></td>`;
  }).join('') + '</tr>').join('');
  grid.innerHTML = `<table class="grid"><thead>${head}</thead><tbody>${rows}</tbody></table>`;
}
function moveDate(n) { S.date = Core.addDays(S.date, n); load(false); }

/* ---------- 칸을 눌렀을 때 ---------- */
function onCell(btn) {
  const hour = Number(btn.dataset.hour), room = btn.dataset.room;
  const b = bookingAt(S.date, hour, room);
  if (b) return openDetail(b);
  const st = Core.slotStatus(S.date, hour, room);
  if (st === 'ok') return openBook(S.date, hour, room);
  toast(Core.STATUS_MSG[st], true);
}
function purposeChips(selected) {
  return '<div class="chips" role="radiogroup" aria-label="용도">' + Core.PURPOSES.map(p =>
    `<label class="chip"><input type="radio" name="purpose" value="${esc(p)}"${p === selected ? ' checked' : ''}><span>${esc(p)}</span></label>`).join('') + '</div>';
}
function pickedPurpose() { const el = document.querySelector('input[name="purpose"]:checked'); return el ? el.value : ''; }

function openBook(date, hour, room) {
  openSheet(`
    <h2>${esc(Core.roomById(room).name)}</h2>
    <p class="info">${esc(dateLabel(date))} · ${hourLabel(hour)}</p>
    <div class="field">용도</div>
    ${purposeChips('')}
    <p class="msg" role="alert"></p>
    <div class="row">
      <button class="btn" data-act="close">닫기</button>
      <button class="btn primary" data-act="doBook" data-date="${date}" data-hour="${hour}" data-room="${room}">예약하기</button>
    </div>`);
}
async function doBook(btn) {
  const purpose = pickedPurpose();
  if (!purpose) { sheetMsg('용도를 골라 주세요.'); return; }
  btn.disabled = true;
  try {
    await Api.call('book', { token: S.session.token, date: btn.dataset.date, hour: Number(btn.dataset.hour), room: btn.dataset.room, purpose });
    closeSheet(); toast('예약했어요.');
  } catch (e) { handleErr(e, 'sheet'); btn.disabled = false; }
  finally { load(true); }
}

function canEdit(b) { return (b.owner === S.session.name || S.session.isAdmin) && !Core.isPast(b.date, b.hour); }
function openDetail(b) {
  const mine = b.owner === S.session.name;
  const edit = canEdit(b);
  openSheet(`
    <h2>${esc(Core.roomById(b.room).name)}</h2>
    <p class="info">${esc(dateLabel(b.date))} · ${hourLabel(b.hour)}</p>
    <dl><dt>예약자</dt><dd>${esc(b.owner)}${mine ? ' (나)' : ''}</dd><dt>용도</dt><dd>${esc(b.purpose)}</dd></dl>
    ${edit && !mine ? '<p class="note">관리자 권한으로 다른 사람의 예약을 바꾸거나 취소하면 시트의 \'기록\' 탭에 남아요.</p>' : ''}
    ${!edit && Core.isPast(b.date, b.hour) ? '<p class="note">이미 지났거나 시작한 예약은 바꾸거나 취소할 수 없어요.</p>' : ''}
    <p class="msg" role="alert"></p>
    <div class="row">
      ${edit ? `<button class="btn danger" data-act="askCancel" data-id="${esc(b.id)}">예약 취소</button>
                <button class="btn primary" data-act="edit" data-id="${esc(b.id)}">바꾸기</button>`
             : '<button class="btn" data-act="close">닫기</button>'}
    </div>
    ${edit ? '<div class="row"><button class="btn" data-act="close">닫기</button></div>' : ''}`);
}
function findCached(id) { return S.cache && S.cache.items.find(b => b.id === id); }
function askCancel(btn) {
  const b = findCached(btn.dataset.id); if (!b) return;
  openSheet(`
    <h2>예약을 취소할까요?</h2>
    <p class="info">${esc(Core.roomById(b.room).name)} · ${esc(dateLabel(b.date))} · ${hourLabel(b.hour)}<br>${esc(b.owner)} · ${esc(b.purpose)}</p>
    <p class="msg" role="alert"></p>
    <div class="row">
      <button class="btn" data-act="close">그대로 두기</button>
      <button class="btn primary" data-act="doCancel" data-id="${esc(b.id)}" style="background:var(--danger);border-color:var(--danger)">취소하기</button>
    </div>`);
}
async function doCancel(btn) {
  btn.disabled = true;
  try { await Api.call('cancel', { token: S.session.token, id: btn.dataset.id }); closeSheet(); toast('예약을 취소했어요.'); }
  catch (e) { handleErr(e, 'sheet'); btn.disabled = false; }
  finally { load(true); }
}

/* 바꾸기: 날짜·시간·상담실·용도 */
function openEdit(btn) {
  const b = findCached(btn.dataset.id); if (!b) return;
  const min = Core.nowKST().date;
  openSheet(`
    <h2>예약 바꾸기</h2>
    <p class="info">지금: ${esc(Core.roomById(b.room).name)} · ${esc(dateLabel(b.date))} · ${hourLabel(b.hour)}</p>
    <label class="field">날짜 <input type="date" id="eDate" value="${b.date}" min="${min}"></label>
    <label class="field">시간 <select id="eHour"></select></label>
    <label class="field">상담실 <select id="eRoom">${Core.ROOMS.map(r => `<option value="${r.id}"${r.id === b.room ? ' selected' : ''}>${esc(r.name)}</option>`).join('')}</select></label>
    <div class="field">용도</div>
    ${purposeChips(b.purpose)}
    <p class="msg" role="alert"></p>
    <div class="row">
      <button class="btn" data-act="close">닫기</button>
      <button class="btn primary" data-act="doEdit" data-id="${esc(b.id)}">저장</button>
    </div>`);
  fillEditHours(b.hour);
}
function fillEditHours(keep) {
  const date = $('#eDate').value, room = $('#eRoom').value;
  const room0 = Core.roomById(room);
  $('#eDate').max = room0 && room0.limited ? Core.oneMonthLater(Core.nowKST().date) : '';
  const hours = Core.parseDate(date) ? Core.hoursFor(date) : [];
  const want = keep != null ? keep : Number($('#eHour').value);
  $('#eHour').innerHTML = hours.length
    ? hours.map(h => {
        const past = Core.isPast(date, h);
        return `<option value="${h}"${h === want && !past ? ' selected' : ''}${past ? ' disabled' : ''}>${hourLabel(h)}${past ? ' (지남)' : ''}</option>`;
      }).join('')
    : '<option value="">이 날은 예약할 수 없어요</option>';
}
async function doEdit(btn) {
  const date = $('#eDate').value, hour = Number($('#eHour').value), room = $('#eRoom').value, purpose = pickedPurpose();
  if (!Core.parseDate(date) || !$('#eHour').value) { sheetMsg('날짜와 시간을 확인해 주세요.'); return; }
  if (!purpose) { sheetMsg('용도를 골라 주세요.'); return; }
  const b = findCached(btn.dataset.id);
  const moved = !b || b.date !== date || b.hour !== hour || b.room !== room;
  if (moved) {
    const st = Core.slotStatus(date, hour, room);
    if (st !== 'ok') { sheetMsg(Core.STATUS_MSG[st]); return; }
  }
  btn.disabled = true;
  try {
    await Api.call('update', { token: S.session.token, id: btn.dataset.id, date, hour, room, purpose });
    closeSheet(); toast('예약을 바꿨어요.');
    if (date !== S.date) { S.date = date; }
  } catch (e) { handleErr(e, 'sheet'); btn.disabled = false; }
  finally { load(true); }
}

/* ---------- 내 메뉴 ---------- */
function openMenu() {
  const a = S.session.isAdmin;
  openSheet(`
    <h2>${esc(S.session.name)}</h2>
    <p class="info">${a ? '관리자' : '직원'}${Api.demo ? ' · 체험 모드' : ''}</p>
    <div class="menu-list">
      <button class="btn" data-act="refresh">🔄 시간표 새로 불러오기</button>
      ${a ? '<button class="btn" data-act="resetMenu">🔑 직원 비밀번호 초기화 (관리자)</button>' : ''}
      ${Api.demo ? '<button class="btn" data-act="demoReset">↺ 체험 자료 처음으로 되돌리기</button>' : ''}
      <button class="btn" data-act="logout">↩ 로그아웃</button>
      <button class="btn" data-act="close">닫기</button>
    </div>`);
}
async function openReset() {
  openSheet('<h2>비밀번호 초기화</h2><p class="info">명단을 불러오는 중…</p>');
  try {
    const res = await Api.call('staff');
    openSheet(`
      <h2>비밀번호 초기화</h2>
      <p class="info">초기화하면 그 직원은 다음 로그인 때 새 비밀번호를 직접 정합니다. 잠긴 상태도 풀립니다.</p>
      <label class="field">직원 <select id="rTarget"><option value="">고르세요</option>${res.staff.map(s =>
        `<option value="${esc(s.name)}">${esc(s.name)}${s.locked ? ' 🔒잠김' : ''}${!s.hasPin ? ' (비밀번호 없음)' : ''}</option>`).join('')}</select></label>
      <p class="note">초기화한 뒤에는 그 직원이 바로 로그인해 새 비밀번호를 정하도록 알려 주세요. 그 전에는 다른 사람이 먼저 정할 수 있어요.</p>
      <p class="msg" role="alert"></p>
      <div class="row"><button class="btn" data-act="close">닫기</button><button class="btn primary" data-act="doReset">초기화</button></div>`);
  } catch (e) { handleErr(e, 'sheet'); }
}
async function doReset(btn) {
  const target = $('#rTarget').value;
  if (!target) { sheetMsg('직원을 골라 주세요.'); return; }
  btn.disabled = true;
  try {
    await Api.call('resetPin', { token: S.session.token, target });
    closeSheet(); toast(`${target}님의 비밀번호를 초기화했어요.`);
    if (target === S.session.name) logout();
  } catch (e) { handleErr(e, 'sheet'); btn.disabled = false; }
}

/* ---------- 버튼 연결 ---------- */
const ACTIONS = {
  login, menu: openMenu, close: closeSheet,
  prev: () => moveDate(-1), next: () => moveDate(1),
  today: () => { S.date = Core.nowKST().date; load(false); },
  cell: onCell, doBook, edit: openEdit, doEdit, askCancel, doCancel,
  refresh: () => { closeSheet(); load(true); toast('새로 불러왔어요.'); },
  resetMenu: openReset, doReset,
  demoReset: () => { DemoStore.load(); DemoStore.reset(); logout(); },
  logout: () => logout()
};
document.addEventListener('click', e => {
  if (e.target.id === 'sheet') { closeSheet(); return; }       // 바깥 어두운 부분을 누르면 닫기
  const btn = e.target.closest('[data-act]');
  if (!btn || btn.disabled) return;
  const fn = ACTIONS[btn.dataset.act];
  if (fn) fn(btn);
});
document.addEventListener('change', e => {
  if (e.target.id === 'loginName') onNamePick();
  if (e.target.id === 'datePicker' && Core.parseDate(e.target.value)) { S.date = e.target.value; load(false); }
  if (e.target.id === 'eDate' || e.target.id === 'eRoom') fillEditHours();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet();
  if (e.key === 'Enter' && !$('#login').hidden && (e.target.id === 'pin1' || e.target.id === 'pin2')) login();
});

/* 1분마다: 지난 시간을 회색으로, 창이 열려 있지 않으면 다른 직원의 예약도 새로 불러오기 */
setInterval(() => {
  if (!S.session || $('#main').hidden) return;
  if ($('#sheet').hidden && document.visibilityState === 'visible') load(true); else render();
}, 60000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.session && !$('#main').hidden && $('#sheet').hidden) load(true);
});

/* ---------- 시작 ---------- */
(async function start() {
  S.session = store(SESSION_KEY);
  if (!S.session || !S.session.token) { logout(); return; }
  enterMain();
  try {   // 관리자 지정이 바뀌었을 수 있으니 확인
    const me = await Api.call('me', { token: S.session.token });
    if (S.session && (me.isAdmin !== S.session.isAdmin)) { S.session.isAdmin = me.isAdmin; store(SESSION_KEY, S.session); enterMain(); }
  } catch (e) { if (e.code === 'auth') handleErr(e); }
})();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
