// ITF Sales Manager — Monday-morning weekly summary email (the old Apps Script
// sendWeeklySummaryEmail): last Monday–Sunday's items sold, revenue and net
// profit, how much stock has sat unsold for 60+ days, and whether the Shopify
// sync is healthy.
//
// Opt-in: only sends when SALES_WEEKLY_SUMMARY_EMAILS is set in Render (a comma-
// separated list), so it won't double up with the old Apps Script trigger while
// both apps are running. Turn that trigger off when you set this.
// The week sent is recorded, so restarts or redeploys never send it twice.
const { db } = require('./db');
const { sendMail } = require('./email');
const { getMeta, setMeta, WEEKLY_LABOUR_COST, WEEKLY_ADS_COST, netBeforeWeekly, num } = require('./sales');
const { syncStatus } = require('./salesShopify');

const TZ = process.env.BACKUP_TIMEZONE || 'Australia/Sydney';
const SEND_HOUR = Number(process.env.SALES_WEEKLY_SUMMARY_HOUR || 7);

function recipients() {
  return (process.env.SALES_WEEKLY_SUMMARY_EMAILS || '').split(',').map((s) => s.trim()).filter(Boolean);
}

function nowParts(date = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false, weekday: 'short',
  }).formatToParts(date).map((x) => [x.type, x.value]));
  return { ymd: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24, weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) };
}
function addDays(ymd, n) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function lastWeekRange(date = new Date()) {
  const { ymd, weekday } = nowParts(date);
  const thisMonday = addDays(ymd, -((weekday + 6) % 7));
  return { from: addDays(thisMonday, -7), to: addDays(thisMonday, -1) };
}
const dmy = (ymd) => `${ymd.slice(8, 10)}/${ymd.slice(5, 7)}/${ymd.slice(0, 4)}`;
const money = (n) => `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// The numbers for one Monday–Sunday week.
function weeklySummary(range) {
  const sales = db.prepare("SELECT * FROM sales_items WHERE kind = 'sale' AND selldate >= ? AND selldate <= ?").all(range.from, range.to);
  const itemsSold = sales.length;
  const revenue = sales.reduce((s, r) => s + num(r.sellprice) + num(r.extendedwarranty), 0);
  let net = sales.reduce((s, r) => s + netBeforeWeekly(r), 0);
  // A full week, so the whole weekly labour + ads comes off once.
  if (itemsSold > 0) net -= (WEEKLY_LABOUR_COST + WEEKLY_ADS_COST);
  const cutoff = Date.now() - 60 * 86400000;
  const slowStock = db.prepare("SELECT COUNT(*) AS c FROM sales_items WHERE kind = 'inventory' AND COALESCE(created_at, last_modified) < ?").get(cutoff).c;
  return { itemsSold, revenue, net, slowStock };
}

function shopifyLine() {
  const s = syncStatus();
  if (!s.configured) return { text: 'Shopify sync: not set up in Work Desk yet', warn: true };
  if (s.ok === false) return { text: `Shopify sync: LAST RUN FAILED — ${s.error}`, warn: true };
  if (!s.lastSyncAt || Date.now() - s.lastSyncAt > 2 * 3600000) return { text: "Shopify sync: hasn't run successfully in over 2 hours — worth checking", warn: true };
  return { text: `Shopify sync: healthy, last ran ${Math.round((Date.now() - s.lastSyncAt) / 60000)} minute(s) ago`, warn: false };
}

async function sendWeeklySummary({ toEmails = recipients(), range = lastWeekRange() } = {}) {
  if (!toEmails.length) return { ok: false, reason: 'not_configured' };
  const s = weeklySummary(range);
  const shop = shopifyLine();
  const period = `${dmy(range.from)} – ${dmy(range.to)}`;
  const text = [
    `Weekly summary for ${period}`, '',
    `Items sold: ${s.itemsSold}`, `Revenue: ${money(s.revenue)}`, `Net profit: ${money(s.net)}`, '',
    `Inventory sitting 60+ days unsold: ${s.slowStock} item(s)`, '', shop.text, '',
    '— IT Factory Work Desk · ITF Sales Manager (automated)',
  ].join('\n');
  const card = (label, value, color = '#1A1A18') => `<td style="width:50%;padding:14px 16px;border:1px solid #E5E3DC;border-radius:10px;">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#6B6A64;margin-bottom:4px;">${label}</div>
      <div style="font-size:22px;font-weight:700;color:${color};">${value}</div></td>`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#1A1A18;">
    <div style="border-left:3px solid #155e6b;padding:16px 20px;margin-bottom:18px;">
      <div style="font-size:18px;font-weight:700;">IT Factory — Weekly Sales Summary</div>
      <div style="font-size:13px;color:#6B6A64;">${esc(period)}</div>
    </div>
    <table style="width:100%;border-collapse:separate;border-spacing:10px 10px;margin:0 -10px 10px;"><tr>
      ${card('Items sold', s.itemsSold)}${card('Revenue', money(s.revenue))}</tr><tr>
      ${card('Net profit', money(s.net), s.net < 0 ? '#A63A34' : '#0F4E45')}${card('Sitting 60+ days', s.slowStock)}</tr></table>
    <div style="font-size:12px;padding:10px 14px;border-radius:8px;margin-bottom:14px;background:${shop.warn ? '#FBEAE8' : '#EAF3EE'};color:${shop.warn ? '#A63A34' : '#0F6E56'};">${esc(shop.text)}</div>
    <div style="font-size:11.5px;color:#8A8880;">Net profit takes off the week's fixed labour (${money(WEEKLY_LABOUR_COST)}) and Google Ads (${money(WEEKLY_ADS_COST)}).<br>IT Factory Work Desk · ITF Sales Manager · automated weekly summary</div>
  </div>`;
  await sendMail({ to: toEmails.join(','), subject: `IT Factory — Weekly Sales Summary (${period})`, text, html });
  return { ok: true, ...s, from: range.from, to: range.to, sentTo: toEmails };
}

async function tick(date = new Date()) {
  if (!recipients().length) return null;
  const { weekday, hour } = nowParts(date);
  if (weekday !== 1 || hour < SEND_HOUR) return null;
  const range = lastWeekRange(date);
  const last = getMeta('weekly_summary_last_from');
  if (last === range.from) return null;
  setMeta('weekly_summary_last_from', range.from); // claim the week first
  try {
    const r = await sendWeeklySummary({ range });
    console.log(`[sales] Weekly summary sent for ${range.from}..${range.to}.`);
    return r;
  } catch (err) {
    setMeta('weekly_summary_last_from', last); // let the next check retry
    console.error('[sales] Weekly summary failed:', err.message);
    return { ok: false, reason: 'send_failed', error: err.message };
  }
}

function startSalesWeeklyScheduler() {
  if (!recipients().length) {
    console.log('[sales] Weekly summary email is off (set SALES_WEEKLY_SUMMARY_EMAILS to turn it on).');
    return;
  }
  console.log(`[sales] Weekly summary email on — Mondays from ${SEND_HOUR}:00 (${TZ}).`);
  tick().catch(() => {});
  setInterval(() => { tick().catch(() => {}); }, 15 * 60 * 1000).unref?.();
}

module.exports = { startSalesWeeklyScheduler, sendWeeklySummary, weeklySummary, lastWeekRange, tick, recipients };
