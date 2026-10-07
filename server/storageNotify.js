// Who gets the "new order placed" email for Storage Centre orders (from staff or
// the client portal). Set STORAGE_NOTIFY_EMAILS on the server to change the list;
// without it, the default team list below is used so the email is never skipped.
const DEFAULT_ORDER_NOTIFY = 'sam@itfactory.com.au,tom@itfactory.com.au,rnahas@itfactory.com.au,michael@itfactory.com.au,admin@itfactory.com.au,elina@itfactory.com.au';

function orderNotifyList() {
  return (process.env.STORAGE_NOTIFY_EMAILS || DEFAULT_ORDER_NOTIFY).split(',').map((s) => s.trim()).filter(Boolean);
}

module.exports = { orderNotifyList, DEFAULT_ORDER_NOTIFY };
