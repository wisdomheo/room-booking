/* 상담실 예약 규칙 — 앱 화면(체험 모드)과 구글 앱스 스크립트(server/Code.gs)가 함께 쓰는 파일.
   이 파일을 고치면 build.ps1을 실행해 server/Code.gs를 다시 만든다.
   저장소(store)는 밖에서 넣어 준다: 구글 시트(SheetStore) 또는 이 기기(DemoStore). */
var Core = (function () {
  'use strict';

  /* ---------- 기본 설정 ---------- */
  var ROOMS = [
    { id: 'r1', name: '상담실 1', short: '상담실1', limited: true },
    { id: 'r2', name: '상담실 2', short: '상담실2', limited: true },
    { id: 'r3', name: '상담실 3', short: '상담실3', limited: true },
    { id: 'g',  name: '집단상담실', short: '집단', limited: false }   // 예약 기간 제한 없음
  ];
  var PURPOSES = ['개인상담', '부모상담', '집단상담', '회의', '기타'];
  var OPEN_HOUR = 9;
  var CLOSE_WEEKDAY = 21;    // 평일 09~21시
  var CLOSE_SATURDAY = 18;   // 토요일 09~18시, 일요일 없음
  var MAX_FAILS = 5;         // 비밀번호 5번 틀리면 잠김
  var TOKEN_DAYS = 30;       // 한 번 로그인하면 30일 유지
  var MAX_LIST_DAYS = 14;
  var PIN_ROUNDS = 300;

  function roomById(id) { for (var i = 0; i < ROOMS.length; i++) if (ROOMS[i].id === id) return ROOMS[i]; return null; }

  /* ---------- 날짜 (모두 한국 시간 기준) ---------- */
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function fmt(t) { return t.getUTCFullYear() + '-' + pad(t.getUTCMonth() + 1) + '-' + pad(t.getUTCDate()); }
  function parseDate(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s));
    if (!m) return null;
    var y = +m[1], mo = +m[2], d = +m[3];
    var t = new Date(Date.UTC(y, mo - 1, d));
    if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
    return t;
  }
  function nowKST(nowMs) {
    var d = new Date((nowMs == null ? Date.now() : nowMs) + 9 * 3600000);
    return { date: fmt(d), hour: d.getUTCHours(), minute: d.getUTCMinutes(),
             stamp: fmt(d) + ' ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) };
  }
  function addDays(s, n) { var t = parseDate(s); t.setUTCDate(t.getUTCDate() + n); return fmt(t); }
  function weekday(s) { return parseDate(s).getUTCDay(); }   // 0 = 일요일
  function hoursFor(s) {
    var w = weekday(s);
    if (w === 0) return [];
    var end = w === 6 ? CLOSE_SATURDAY : CLOSE_WEEKDAY, a = [];
    for (var h = OPEN_HOUR; h < end; h++) a.push(h);
    return a;
  }
  /* 한 달 뒤 같은 날짜 (1월 31일 → 2월 28/29일) */
  function oneMonthLater(s) {
    var t = parseDate(s), y = t.getUTCFullYear(), m = t.getUTCMonth(), d = t.getUTCDate();
    var ny = m === 11 ? y + 1 : y, nm = (m + 1) % 12;
    var last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
    return fmt(new Date(Date.UTC(ny, nm, Math.min(d, last))));
  }
  function isPast(date, hour, nowMs) {
    var n = nowKST(nowMs);
    return date < n.date || (date === n.date && hour <= n.hour);   // 이미 시작한 시간도 지난 것으로 본다
  }
  /* 칸 상태: ok / closed(운영 시간 아님) / past(지난 시간) / far(한 달 넘음) */
  function slotStatus(date, hour, roomId, nowMs) {
    if (!parseDate(date)) return 'closed';
    if (hoursFor(date).indexOf(hour) < 0) return 'closed';
    if (isPast(date, hour, nowMs)) return 'past';
    var room = roomById(roomId);
    if (room && room.limited && date > oneMonthLater(nowKST(nowMs).date)) return 'far';
    return 'ok';
  }
  var STATUS_MSG = {
    closed: '예약할 수 없는 시간이에요. (평일 9~21시, 토요일 9~18시, 일요일 없음)',
    past: '이미 지났거나 시작한 시간은 예약하거나 바꿀 수 없어요.',
    far: '상담실 1·2·3은 오늘부터 한 달 뒤 같은 날짜까지만 예약할 수 있어요.'
  };

  /* ---------- 암호화 (SHA-256, HMAC) — 외부 도구 없이 동작 ---------- */
  var K = [], H0 = [];
  (function () {
    var primes = [], n = 2;
    while (primes.length < 64) { var p = true; for (var i = 0; i < primes.length; i++) if (n % primes[i] === 0) { p = false; break; } if (p) primes.push(n); n++; }
    for (var j = 0; j < 64; j++) {
      var c = Math.pow(primes[j], 1 / 3); K[j] = ((c - Math.floor(c)) * 0x100000000) | 0;
      if (j < 8) { var s = Math.sqrt(primes[j]); H0[j] = ((s - Math.floor(s)) * 0x100000000) | 0; }
    }
  })();
  function utf8Bytes(str) {
    var s = unescape(encodeURIComponent(String(str))), b = [];
    for (var i = 0; i < s.length; i++) b.push(s.charCodeAt(i));
    return b;
  }
  function rr(v, a) { return (v >>> a) | (v << (32 - a)); }
  function sha256Bytes(input) {
    var bytes = input.slice(0), l = input.length, i, j;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    var bits = l * 8, hi = Math.floor(bits / 0x100000000), lo = bits >>> 0;
    bytes.push((hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255,
               (lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255);
    var H = H0.slice(0), w = new Array(64);
    for (i = 0; i < bytes.length; i += 64) {
      for (j = 0; j < 16; j++) w[j] = (bytes[i + 4 * j] << 24) | (bytes[i + 4 * j + 1] << 16) | (bytes[i + 4 * j + 2] << 8) | bytes[i + 4 * j + 3];
      for (j = 16; j < 64; j++) {
        var x = w[j - 15], y = w[j - 2];
        w[j] = (w[j - 16] + (rr(x, 7) ^ rr(x, 18) ^ (x >>> 3)) + w[j - 7] + (rr(y, 17) ^ rr(y, 19) ^ (y >>> 10))) | 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (j = 0; j < 64; j++) {
        var t1 = (h + (rr(e, 6) ^ rr(e, 11) ^ rr(e, 25)) + ((e & f) ^ (~e & g)) + K[j] + w[j]) | 0;
        var t2 = ((rr(a, 2) ^ rr(a, 13) ^ rr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    var out = [];
    for (i = 0; i < 8; i++) out.push((H[i] >>> 24) & 255, (H[i] >>> 16) & 255, (H[i] >>> 8) & 255, H[i] & 255);
    return out;
  }
  function hex(bytes) { var s = ''; for (var i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16); return s; }
  function sha256(str) { return hex(sha256Bytes(utf8Bytes(str))); }
  function hmac(key, msg) {
    var k = utf8Bytes(key);
    if (k.length > 64) k = sha256Bytes(k);
    while (k.length < 64) k.push(0);
    var ip = [], op = [];
    for (var i = 0; i < 64; i++) { ip.push(k[i] ^ 0x36); op.push(k[i] ^ 0x5c); }
    return hex(sha256Bytes(op.concat(sha256Bytes(ip.concat(utf8Bytes(msg))))));
  }
  function hashPin(pin, salt) {
    var h = salt + ':' + pin;
    for (var i = 0; i < PIN_ROUNDS; i++) h = sha256(h + ':' + salt);
    return h;
  }

  /* ---------- 로그인 표 (토큰) ---------- */
  function makeToken(staff, secret, nowMs) {
    var exp = (nowMs == null ? Date.now() : nowMs) + TOKEN_DAYS * 86400000;
    var body = encodeURIComponent(staff.name) + '.' + exp;
    return body + '.' + hmac(secret, body + '.' + (staff.pinHash || '')).slice(0, 40);
  }
  function readToken(token, store, nowMs) {
    var parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    var name;
    try { name = decodeURIComponent(parts[0]); } catch (e) { return null; }
    var exp = +parts[1];
    if (!(exp > (nowMs == null ? Date.now() : nowMs))) return null;
    var staff = store.getStaff(name);
    if (!staff || !staff.active || staff.locked || !staff.pinHash) return null;
    var want = hmac(store.secret(), parts[0] + '.' + parts[1] + '.' + staff.pinHash).slice(0, 40);
    return want === parts[2] ? staff : null;
  }

  /* ---------- 요청 처리 ---------- */
  function fail(error, code) { return { ok: false, error: error, code: code || 'error' }; }
  function pub(b) { return { id: b.id, date: b.date, hour: b.hour, room: b.room, purpose: b.purpose, owner: b.owner }; }
  function describe(b) { var r = roomById(b.room); return b.date + ' ' + pad(b.hour) + ':00 ' + (r ? r.name : b.room) + ' (' + b.purpose + ')'; }
  function checkFields(req) {
    if (!parseDate(req.date)) return '날짜가 올바르지 않아요.';
    req.hour = Number(req.hour);
    if (!roomById(req.room)) return '상담실을 골라 주세요.';
    if (PURPOSES.indexOf(req.purpose) < 0) return '용도를 골라 주세요.';
    return '';
  }

  /* req: { action, ... }  store: 저장소  nowMs: 지금 시각  rand(): 무작위 문자열 */
  function handle(req, store, nowMs, rand) {
    req = req || {};
    var now = nowKST(nowMs), me, b, err, st;
    switch (req.action) {

      case 'staff':
        return { ok: true, staff: store.listStaff().filter(function (s) { return s.active; })
          .map(function (s) { return { name: s.name, hasPin: !!s.pinHash, locked: !!s.locked }; }) };

      case 'login': {
        var s = store.getStaff(String(req.name || ''));
        if (!s || !s.active) return fail('명단에 없는 이름이에요. 관리자에게 확인해 주세요.');
        if (s.locked) return fail('비밀번호를 ' + MAX_FAILS + '번 틀려 잠겼어요. 관리자에게 초기화를 요청해 주세요.', 'locked');
        var pin = String(req.pin || '');
        if (!/^\d{4}$/.test(pin)) return fail('비밀번호는 숫자 4자리예요.');
        if (!s.pinHash) {                       // 처음 사용하거나 초기화된 경우: 새 비밀번호 저장
          s.salt = rand(); s.pinHash = hashPin(pin, s.salt); s.fails = 0;
          store.saveStaff(s);
        } else if (hashPin(pin, s.salt) !== s.pinHash) {
          s.fails = (s.fails || 0) + 1;
          if (s.fails >= MAX_FAILS) s.locked = true;
          store.saveStaff(s);
          return s.locked ? fail('비밀번호를 ' + MAX_FAILS + '번 틀려 잠겼어요. 관리자에게 초기화를 요청해 주세요.', 'locked')
                          : fail('비밀번호가 맞지 않아요. (' + (MAX_FAILS - s.fails) + '번 더 틀리면 잠겨요)', 'badpin');
        } else if (s.fails) { s.fails = 0; store.saveStaff(s); }
        return { ok: true, token: makeToken(s, store.secret(), nowMs), name: s.name, isAdmin: !!s.isAdmin };
      }
    }

    /* 여기부터는 로그인한 사람만 */
    me = readToken(req.token, store, nowMs);
    if (!me) return fail('다시 로그인해 주세요.', 'auth');

    switch (req.action) {
      case 'me':
        return { ok: true, name: me.name, isAdmin: !!me.isAdmin };

      case 'list': {
        if (!parseDate(req.from) || !parseDate(req.to) || req.to < req.from) return fail('날짜 범위가 올바르지 않아요.');
        if (req.to > addDays(req.from, MAX_LIST_DAYS)) return fail('한 번에 2주까지만 볼 수 있어요.');
        return { ok: true, now: now, bookings: store.listBookings(req.from, req.to).map(pub) };
      }

      case 'book': {
        err = checkFields(req); if (err) return fail(err);
        st = slotStatus(req.date, req.hour, req.room, nowMs);
        if (st !== 'ok') return fail(STATUS_MSG[st], st);
        if (store.findSlot(req.date, req.hour, req.room)) return fail('방금 다른 분이 이 시간을 예약했어요. 시간표를 새로 불러왔어요.', 'taken');
        b = { id: rand(), date: req.date, hour: req.hour, room: req.room, purpose: req.purpose, owner: me.name,
              created: now.stamp, updated: '' };
        store.addBooking(b);
        return { ok: true, booking: pub(b) };
      }

      case 'update':
      case 'cancel': {
        b = store.findBooking(String(req.id || ''));
        if (!b) return fail('이미 취소되었거나 없는 예약이에요.', 'gone');
        var isOwner = b.owner === me.name;
        if (!isOwner && !me.isAdmin) return fail('자기 예약만 바꾸거나 취소할 수 있어요.', 'forbidden');
        if (isPast(b.date, b.hour, nowMs)) return fail(STATUS_MSG.past, 'past');
        var before = describe(b);

        if (req.action === 'cancel') {
          store.removeBooking(b.id);
          if (!isOwner) store.addLog({ time: now.stamp, actor: me.name, action: '예약 취소', owner: b.owner, before: before, after: '' });
          return { ok: true };
        }
        err = checkFields(req); if (err) return fail(err);
        var moved = req.date !== b.date || req.hour !== b.hour || req.room !== b.room;
        if (moved) {
          st = slotStatus(req.date, req.hour, req.room, nowMs);
          if (st !== 'ok') return fail(STATUS_MSG[st], st);
          var other = store.findSlot(req.date, req.hour, req.room);
          if (other && other.id !== b.id) return fail('그 시간에는 이미 다른 예약이 있어요.', 'taken');
        }
        b.date = req.date; b.hour = req.hour; b.room = req.room; b.purpose = req.purpose; b.updated = now.stamp;
        store.updateBooking(b);
        if (!isOwner) store.addLog({ time: now.stamp, actor: me.name, action: '예약 바꾸기', owner: b.owner, before: before, after: describe(b) });
        return { ok: true, booking: pub(b) };
      }

      case 'resetPin': {
        if (!me.isAdmin) return fail('관리자만 할 수 있어요.', 'forbidden');
        var t = store.getStaff(String(req.target || ''));
        if (!t) return fail('명단에 없는 이름이에요.');
        t.pinHash = ''; t.salt = ''; t.fails = 0; t.locked = false;
        store.saveStaff(t);
        store.addLog({ time: now.stamp, actor: me.name, action: '비밀번호 초기화', owner: t.name, before: '', after: '' });
        return { ok: true };
      }
    }
    return fail('알 수 없는 요청이에요.');
  }

  return {
    ROOMS: ROOMS, PURPOSES: PURPOSES, MAX_FAILS: MAX_FAILS,
    roomById: roomById, nowKST: nowKST, parseDate: parseDate, addDays: addDays, weekday: weekday,
    hoursFor: hoursFor, oneMonthLater: oneMonthLater, isPast: isPast, slotStatus: slotStatus, STATUS_MSG: STATUS_MSG,
    sha256: sha256, hmac: hmac, hashPin: hashPin, handle: handle
  };
})();
