// Admin summary page. Logs in through /auth/login, then:
//  - the WebSocket delivers the summary snapshot and live booking events;
//  - GET /admin/bookings fills the table of all bookings, one page at a time.
// The token lives only in this page's memory: reloading the page logs out.
(() => {
  'use strict';

  const PAGE_SIZE = 20;
  const MAX_EVENTS = 30;
  const CLOSE_UNAUTHORIZED = 4401;
  const CLOSE_FORBIDDEN = 4403;

  const $ = (id) => document.getElementById(id);
  const el = (tag, text, className) => {
    const node = document.createElement(tag);
    // textContent only, never innerHTML: values from the API are shown as text, not markup.
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };

  let token = null;
  let socket = null;
  let reconnectTimer = null;
  let reconnectDelayMs = 1000;
  let refreshTimer = null;
  const view = { status: '', offset: 0, total: 0 };

  const baht = (satang) =>
    `${(satang / 100).toLocaleString('th-TH', { minimumFractionDigits: 2 })} บาท`;
  // YYYY-MM-DD HH:mm:ss at the resort, the same calendar and order as the check-in dates
  // (the th-TH locale would print Buddhist-era years next to Gregorian stay dates).
  const dateTime = (iso) => new Date(iso).toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' });
  const STATUS_LABEL = { confirmed: 'ยืนยันแล้ว', cancelled: 'ยกเลิกแล้ว' };

  function setConnection(state, text) {
    const badge = $('connection');
    badge.className = `badge ${state}`;
    badge.textContent = text;
  }

  // ---- Rendering -------------------------------------------------------------------------

  function renderSummary(snapshot) {
    const s = snapshot.summary;
    const cards = [
      ['ห้องทั้งหมด', s.totalRooms],
      ['มีผู้เข้าพักคืนนี้', `${s.roomsOccupiedTonight} / ${s.totalRooms}`],
      ['Check-in วันนี้', s.checkInsToday],
      ['Check-out วันนี้', s.checkOutsToday],
      ['การจองที่ยังไม่ check-out', s.activeBookings],
      ['การจองที่ยกเลิก', s.cancelledBookings],
      ['รายได้จากการจองที่ยืนยัน', baht(s.confirmedRevenueSatang)],
    ];
    const container = $('summary');
    container.replaceChildren(
      ...cards.map(([label, value]) => {
        const card = el('div', undefined, 'card');
        card.append(el('div', label, 'label'), el('div', String(value), 'value'));
        return card;
      }),
    );
    $('summary-date').textContent = `ณ วันที่ ${snapshot.date}`;
  }

  function renderBookings(page) {
    view.total = page.total;
    const rows = page.bookings.map((booking) => {
      const row = el('tr');
      const rules = booking.priceRules.map((rule) => rule.code).join(', ') || '-';
      row.append(
        el('td', booking.id),
        el('td', booking.roomName),
        el('td', booking.userEmail),
        el('td', booking.checkIn),
        el('td', booking.checkOut),
        el('td', STATUS_LABEL[booking.status] || booking.status, `status-${booking.status}`),
        el('td', baht(booking.nightlyPriceSatang), 'num'),
        el('td', baht(booking.totalPriceSatang), 'num'),
        el('td', rules),
        el('td', dateTime(booking.createdAt)),
      );
      return row;
    });
    if (rows.length === 0) {
      const row = el('tr');
      const cell = el('td', 'ไม่มีการจอง', 'muted');
      cell.colSpan = 10;
      row.append(cell);
      rows.push(row);
    }
    $('bookings').replaceChildren(...rows);

    const first = page.total === 0 ? 0 : page.offset + 1;
    const last = page.offset + page.bookings.length;
    $('bookings-total').textContent = `(${page.total} รายการ)`;
    $('page-info').textContent = `แสดง ${first}-${last} จาก ${page.total}`;
    $('prev').disabled = page.offset === 0;
    $('next').disabled = last >= page.total;
  }

  function addEvent(event) {
    const label = event.type === 'booking.created' ? 'จองใหม่' : 'ยกเลิก';
    const b = event.booking;
    const text = `${dateTime(event.occurredAt)}  ${label}  #${b.id}  ${b.checkIn} ถึง ${b.checkOut}  ${baht(b.totalPriceSatang)}`;
    const list = $('events');
    list.prepend(el('li', text));
    while (list.children.length > MAX_EVENTS) list.lastElementChild.remove();
  }

  // ---- Data ------------------------------------------------------------------------------

  async function loadBookings() {
    if (!token) return;
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(view.offset) });
    if (view.status) params.set('status', view.status);
    const response = await fetch(`/admin/bookings?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (response.status === 401 || response.status === 403) {
      logout('เซสชันหมดอายุ กรุณาเข้าสู่ระบบอีกครั้ง');
      return;
    }
    if (!response.ok) return; // e.g. rate limited: keep what is shown, the next event retries.
    const page = await response.json();
    // The last page can empty out after cancellations are filtered away; step back to data.
    if (page.bookings.length === 0 && page.total > 0 && view.offset > 0) {
      view.offset = Math.max(0, Math.floor((page.total - 1) / PAGE_SIZE) * PAGE_SIZE);
      await loadBookings();
      return;
    }
    renderBookings(page);
  }

  /** After an event, refresh the summary and the table once, even if many events arrive. */
  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'snapshot' }));
      }
      loadBookings().catch(() => undefined);
    }, 300);
  }

  // ---- WebSocket -------------------------------------------------------------------------

  function connect() {
    clearTimeout(reconnectTimer);
    if (!token) return;
    setConnection('waiting', 'กำลังเชื่อมต่อ');
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${scheme}//${location.host}/admin/dashboard/ws`);
    socket = ws;

    // Browsers cannot set an Authorization header on a WebSocket, so the token is sent as
    // the first message instead of in the URL.
    ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'auth', token })));

    ws.addEventListener('message', (message) => {
      let data;
      try {
        data = JSON.parse(message.data);
      } catch {
        return;
      }
      if (data.type === 'snapshot') {
        reconnectDelayMs = 1000;
        setConnection('live', 'เชื่อมต่อแล้ว (real-time)');
        renderSummary(data.data);
      } else if (data.type === 'booking.created' || data.type === 'booking.cancelled') {
        addEvent(data);
        scheduleRefresh();
      }
    });

    ws.addEventListener('close', (event) => {
      if (socket !== ws) return; // replaced by a newer connection or closed by logout
      socket = null;
      if (event.code === CLOSE_UNAUTHORIZED || event.code === CLOSE_FORBIDDEN) {
        logout(
          event.code === CLOSE_FORBIDDEN
            ? 'บัญชีนี้ไม่มีสิทธิ์ผู้ดูแล'
            : 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบอีกครั้ง',
        );
        return;
      }
      setConnection('waiting', 'การเชื่อมต่อหลุด กำลังลองใหม่');
      reconnectTimer = setTimeout(() => {
        connect();
        // Events sent while disconnected are not replayed, so reload the table as well.
        loadBookings().catch(() => undefined);
      }, reconnectDelayMs);
      reconnectDelayMs = Math.min(reconnectDelayMs * 2, 30000);
    });
  }

  // ---- Session ---------------------------------------------------------------------------

  function showDashboard(visible) {
    $('login').hidden = visible;
    $('dashboard').hidden = !visible;
    $('logout').hidden = !visible;
  }

  function logout(message) {
    token = null;
    clearTimeout(reconnectTimer);
    clearTimeout(refreshTimer);
    const ws = socket;
    socket = null;
    if (ws) ws.close();
    setConnection('off', 'ยังไม่เชื่อมต่อ');
    showDashboard(false);
    $('login-error').textContent = message || '';
    $('bookings').replaceChildren();
    $('summary').replaceChildren();
    $('events').replaceChildren();
  }

  async function login(email, password) {
    const response = await fetch('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (response.status === 429) throw new Error('พยายามเข้าสู่ระบบบ่อยเกินไป กรุณารอสักครู่');
    if (!response.ok) throw new Error('อีเมลหรือรหัสผ่านไม่ถูกต้อง');
    const body = await response.json();
    if (body.user.role !== 'admin') throw new Error('บัญชีนี้ไม่มีสิทธิ์ผู้ดูแล');
    return body.accessToken;
  }

  $('login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    $('login-error').textContent = '';
    try {
      token = await login($('email').value, $('password').value);
    } catch (error) {
      $('login-error').textContent = error.message;
      return;
    }
    $('password').value = '';
    view.offset = 0;
    showDashboard(true);
    connect();
    loadBookings().catch(() => undefined);
  });

  $('logout').addEventListener('click', () => logout(''));
  $('status-filter').addEventListener('change', (event) => {
    view.status = event.target.value;
    view.offset = 0;
    loadBookings().catch(() => undefined);
  });
  $('prev').addEventListener('click', () => {
    view.offset = Math.max(0, view.offset - PAGE_SIZE);
    loadBookings().catch(() => undefined);
  });
  $('next').addEventListener('click', () => {
    if (view.offset + PAGE_SIZE < view.total) view.offset += PAGE_SIZE;
    loadBookings().catch(() => undefined);
  });
})();
