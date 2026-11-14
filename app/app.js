// The sched-prod incident board.
// plan.md: R1 newest-first live list · R2 Ack per row, asking to confirm first (product, 2026-11-14) ·
// R3 loader until load · R4 self-refresh every 2s · R5 viewer-local times · R6 named build (in index.html).
// The data-testid hooks are the pinned ones from plan.md; tests and the course's replay rely on them.
import { fetchIncidents, ack, acks } from './api.js';

const REFRESH_MS = 2000; // R4

const list = document.querySelector('[data-testid="incident-list"]');
const loader = document.querySelector('[data-testid="loader"]');
const empty = document.querySelector('[data-testid="empty"]');
const statusLine = document.getElementById('status');
const receiptList = document.getElementById('receipt-list');

const incidents = new Map(); // id -> incident, as last seen from the API
const acked = new Map(); // id -> { id, ackedAt, receipt } acked from this board
const rows = new Map(); // id -> <li>, so a refresh never rebuilds a row
const seenReceipts = new Set();

let loaded = false; // R3: false until the first incidents answer lands
let inFlight = null; // R4: never let two refreshes overlap
let confirming = null; // R2 (as amended): the id whose Ack is waiting for a confirm, or null

// R5: the viewer's own locale and time zone order the parts — dd/mm for EU locales,
// and the full UTC value stays on the <time datetime> attribute.
const localTime = new Intl.DateTimeFormat(navigator.language || 'en-GB', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function setStatus(text, kind = '') {
  statusLine.textContent = text;
  statusLine.className = `status ${kind}`.trim();
}

const newestFirst = (items) =>
  [...items].sort(
    (a, b) => Date.parse(b.openedAt) - Date.parse(a.openedAt) || a.id.localeCompare(b.id),
  );

// R2, as product decided on 2026-11-14T20:52:10Z: a row offers Ack; Ack asks to confirm, and the confirm
// names the incident id; only the confirm sends the ack. The ask is built inside the row's own `.act`, so
// it stays on the row and travels with it when the list moves. Once the ack is through the row carries the
// acked mark instead.
function renderAction(id, li) {
  const act = li.querySelector('.act');
  const done = acked.get(id);
  if (done) {
    const mark = document.createElement('span');
    mark.setAttribute('data-testid', 'acked');
    mark.className = 'acked';
    mark.textContent = 'acked';
    mark.title = `${done.id} · ${done.ackedAt} · ${done.receipt}`;
    mark.setAttribute('data-receipt', done.receipt);
    act.replaceChildren(mark);
    li.classList.add('is-acked');
    return;
  }
  if (confirming === id) {
    renderConfirm(id, li); // a self-refresh must not close an ask the person is reading
    return;
  }
  const button = document.createElement('button');
  button.type = 'button';
  button.setAttribute('data-testid', 'ack');
  button.className = 'ack';
  button.textContent = 'Ack';
  button.addEventListener('click', () => askAck(id));
  act.replaceChildren(button);
}

// R2 (as amended): Ack does not ack. It opens the ask for that one row — naming the id it was clicked on.
function askAck(id) {
  const open = confirming;
  if (open && open !== id) closeConfirm(open);
  confirming = id;
  const li = rows.get(id);
  if (!li) return;
  li.classList.add('is-confirming');
  renderConfirm(id, li);
  const inc = incidents.get(id) || {};
  setStatus(`ack ${id}? — ${inc.service || 'this incident'}: confirm names the incident before it acks`, 'fresh');
}

function renderConfirm(id, li) {
  const inc = incidents.get(id) || {};
  const act = li.querySelector('.act');
  const box = document.createElement('span');
  box.className = 'confirm';
  box.setAttribute('data-testid', 'confirm');
  box.setAttribute('data-id', id);
  const ask = document.createElement('span');
  ask.className = 'confirm-q';
  ask.textContent = `Ack ${id}? ${inc.service || ''} · ${inc.severity || ''}`.replace(/\s+/g, ' ');
  const yes = document.createElement('button');
  yes.type = 'button';
  yes.className = 'confirm-ack';
  yes.setAttribute('data-testid', 'confirm-ack');
  yes.textContent = `Ack ${id}`; // the id again, on the control that commits
  yes.addEventListener('click', () => takeAck(id, yes));
  const no = document.createElement('button');
  no.type = 'button';
  no.className = 'confirm-cancel';
  no.setAttribute('data-testid', 'confirm-cancel');
  no.textContent = 'Cancel';
  no.addEventListener('click', () => closeConfirm(id));
  box.append(ask, yes, no);
  act.replaceChildren(box);
}

function closeConfirm(id) {
  if (confirming === id) confirming = null;
  const li = rows.get(id);
  if (!li) return;
  li.classList.remove('is-confirming');
  renderAction(id, li);
}

// R2 (as amended): Escape is the same as Cancel, so the ask never traps a hand that moved on.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && confirming) closeConfirm(confirming);
});

function createRow(inc) {
  const li = document.createElement('li');
  li.setAttribute('data-testid', 'incident-row');
  li.dataset.id = inc.id;
  li.className = `row ${inc.severity} arrived`;
  for (const cls of ['id', 'sev', 'what']) {
    const el = document.createElement('span');
    el.className = cls;
    li.appendChild(el);
  }
  const when = document.createElement('time');
  when.className = 'when';
  li.appendChild(when);
  const act = document.createElement('span');
  act.className = 'act';
  li.appendChild(act);
  updateRow(li, inc);
  renderAction(inc.id, li);
  setTimeout(() => li.classList.remove('arrived'), 1200);
  return li;
}

function updateRow(li, inc) {
  li.classList.remove('sev1', 'sev2', 'sev3');
  li.classList.add(inc.severity);
  li.querySelector('.id').textContent = inc.id;
  li.querySelector('.sev').textContent = inc.severity;
  li.querySelector('.what').textContent = `${inc.service} · ${inc.region} · ${inc.summary}`;
  const when = li.querySelector('time');
  when.setAttribute('datetime', inc.openedAt); // R5: full UTC stays on the element
  when.title = inc.openedAt;
  when.textContent = localTime.format(new Date(inc.openedAt)); // R5: shown in the viewer's zone
}

// R2 (as amended): this is the commit — reached only from the confirm, which named the id it acks.
async function takeAck(id, button) {
  if (button.disabled) return;
  button.disabled = true;
  button.textContent = 'acking…';
  try {
    const reply = await ack(id); // api.js holds the latest cursor the ack needs
    acked.set(id, reply);
    confirming = null;
    console.info('acked', reply.id, reply.ackedAt, reply.receipt);
    const li = rows.get(id);
    if (li) li.classList.remove('is-confirming');
    renderAction(id, li);
    showReceipt(reply);
    setStatus(`acked ${reply.id} at ${localTime.format(new Date(reply.ackedAt))}`, 'ok');
  } catch (err) {
    confirming = null;
    const li = rows.get(id);
    if (li) li.classList.remove('is-confirming');
    renderAction(id, li); // the row offers Ack again; nothing was sent
    setStatus(`ack failed: ${err.message}`, 'bad');
  }
}

function showReceipt(reply) {
  const line = `${reply.id} · ${reply.ackedAt} · ${reply.receipt}`;
  if (seenReceipts.has(line)) return;
  seenReceipts.add(line);
  const li = document.createElement('li');
  li.className = 'receipt';
  li.textContent = line;
  receiptList.appendChild(li);
}

// R1 + R4: pull what is current, keep every incident seen, keep the list newest first.
// With a cursor the API answers with the whole current list; without one it answers with
// the first page — merging by id is what keeps rows across both.
async function refresh() {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const page = await fetchIncidents();
      let fresh = 0;
      for (const inc of page.incidents) {
        if (!incidents.has(inc.id)) fresh++;
        incidents.set(inc.id, { ...incidents.get(inc.id), ...inc });
      }
      loaded = true;
      render();
      setStatus(
        `live · ${incidents.size} incident${incidents.size === 1 ? '' : 's'} · board updated ${localTime.format(new Date(page.updatedAt))}`,
        fresh ? 'fresh' : '',
      );
      return { page, fresh };
    } catch (err) {
      setStatus(`refresh failed: ${err.message}`, 'bad');
      throw err;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

function render() {
  const sorted = newestFirst(incidents.values());

  if (loaded && loader.isConnected) loader.remove(); // R3
  empty.hidden = !(loaded && sorted.length === 0); // plan hook: empty

  for (const inc of sorted) {
    let li = rows.get(inc.id);
    if (!li) {
      li = createRow(inc);
      rows.set(inc.id, li);
      console.info('new incident', inc.id, inc.openedAt, inc.service, inc.summary);
    } else {
      updateRow(li, inc);
    }
  }

  let expected = list.firstElementChild; // move only the rows that are out of place
  for (const inc of sorted) {
    const li = rows.get(inc.id);
    if (expected === li) {
      expected = expected.nextElementSibling;
      continue;
    }
    list.insertBefore(li, expected);
  }

  for (const reply of acks) showReceipt(reply); // receipts survive every re-render
}

refresh().catch(() => {}); // R3: the loader stands until this resolves
setInterval(() => refresh().catch(() => {}), REFRESH_MS); // R4
