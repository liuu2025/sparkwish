const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = process.env.MINIPROGRAM_ROOT || path.resolve(__dirname, '../miniprogram');
const tick = () => new Promise(resolve => setImmediate(resolve));
const token = n => n.toString(16).padStart(64, '0');
const plan = (id = 'synthetic-plan', version = 1) => ({ id, version });
const attempt = (id = 'synthetic-plan', version = 1, checkoutID = 'synthetic-original') => ({ projectID: 'synthetic-project', planID: id, planVersion: version, checkoutID });
const parameters = { virtual_payment: { mode: 'short_series_goods', signData: 'synthetic', paySig: 'synthetic', signature: 'synthetic' } };

function fixture(options = {}) {
  const config = { baseURL: 'https://fixture.invalid', projectID: 'synthetic-project', ordersEnabled: true, paymentEnabled: true, paymentMethod: 'virtual', planIDs: [], ...options };
  const calls = { logins: [], checks: [], requests: [], payments: [], events: [], toasts: [], navigation: [] };
  const storage = new Map(), faults = {}, timers = new Map(), modules = new Map();
  const clock = { now: 1000000 };
  let timerID = 0, definition, loadingVisible = false;
  const wx = {
    login: value => calls.logins.push(value),
    checkSession: value => calls.checks.push(value),
    request: value => calls.requests.push({ ...value, path: value.url.slice(config.baseURL.length + '/api/shop/'.length) }),
    requestVirtualPayment(value) { calls.events.push({ kind: 'native-pay', loadingVisible }); calls.payments.push(value); },
    getStorageSync(key) { if (faults.read) throw Error('synthetic storage failure'); return storage.has(key) ? structuredClone(storage.get(key)) : undefined; },
    setStorageSync(key, value) { if (faults.write) throw Error('synthetic storage failure'); storage.set(key, structuredClone(value)); },
    removeStorageSync(key) { storage.delete(key); },
    showLoading(value) { loadingVisible = true; calls.events.push({ kind: 'show', title: value.title }); },
    hideLoading() { loadingVisible = false; calls.events.push({ kind: 'hide' }); },
    showToast: value => calls.toasts.push(value),
    navigateTo: value => calls.navigation.push(value.url),
    getAccountInfoSync: () => ({ miniProgram: { envVersion: 'develop' } }),
  };
  class ClockDate extends Date { static now() { return clock.now; } }
  function load(file) {
    const filename = path.join(root, file);
    if (modules.has(filename)) return modules.get(filename).exports;
    const module = { exports: {} }; modules.set(filename, module);
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
      module, wx, Promise, Date: ClockDate,
      setTimeout(callback, delay) { const id = ++timerID; timers.set(id, { callback, delay }); return id; },
      clearTimeout: id => timers.delete(id),
      Page: value => { definition = value; },
      App: value => { definition = value; },
      require(id) {
        if (id.endsWith('/config/shop')) return config;
        if (id.endsWith('/perf')) return { mark() {} };
        return load(path.relative(root, path.resolve(path.dirname(filename), id + '.js')));
      },
    }, { filename });
    return module.exports;
  }
  const shop = load('utils/shop.js'), pay = load('utils/pay.js');
  function page(file = 'pages/pro/index.js') {
    load(file);
    const value = { ...definition, data: structuredClone(definition.data || {}) };
    value.writes = [];
    value.setData = (patch, callback) => { value.writes.push(patch); Object.assign(value.data, patch); if (callback) callback(); };
    return value;
  }
  function pending(name) { return calls.requests.filter(value => value.path === name && !value.done); }
  function reply(request, data, status = 200, error = 'synthetic_error') {
    assert.ok(request, 'Expected synthetic request'); request.done = true;
    request.success({ statusCode: status, data: status === 200 ? { code: 0, data } : { code: status, error, message: '合成错误' } });
  }
  function fail(request) { assert.ok(request); request.done = true; request.fail({ errMsg: 'synthetic timeout' }); }
  async function finishLogin(n = 1, ttl = 604800) {
    const current = calls.logins.find(value => !value.done); assert.ok(current, 'Expected wx.login'); current.done = true;
    current.success({ code: 'synthetic-code-' + n }); await tick();
    reply(pending('mini/login')[0], { token: token(n), expires_in: ttl }); await tick();
  }
  async function authenticated() { const ready = shop.ensureLogin(); await tick(); await finishLogin(); await ready; }
  async function approveCheck() { await tick(); const current = calls.checks.find(value => !value.done); assert.ok(current, 'Expected wx.checkSession'); current.done = true; current.success({}); await tick(); }
  return { config, calls, storage, faults, timers, clock, wx, shop, pay, page, load, pending, reply, fail, finishLogin, authenticated, approveCheck, get loadingVisible() { return loadingVisible; } };
}

test('entry prepares identity independently from catalog and creates no order', async () => {
  const f = fixture(), page = f.page(); page.onLoad(); await tick();
  assert.equal(f.pending('catalog?app_id=synthetic-project').length, 1);
  assert.equal(f.calls.logins.length, 1);
  assert.equal(f.pending('checkout-id').length, 0);
  assert.equal(f.pending('orders').length, 0);
  assert.equal(f.calls.payments.length, 0);
  f.reply(f.pending('catalog?app_id=synthetic-project')[0], { plans: [{ ...plan(), name: '合成套餐', price_cents: 800 }] }); await tick();
  assert.equal(page.data.plans.length, 1, 'catalog renders before identity preparation completes');
  await f.finishLogin();
});

test('failed background login does not mark the catalog as failed', async () => {
  const f = fixture(), page = f.page(); page.onLoad(); await tick();
  f.calls.logins[0].done = true; f.calls.logins[0].fail({});
  f.reply(f.pending('catalog?app_id=synthetic-project')[0], { plans: [] }); await tick();
  assert.equal(page.data.failed, false); assert.equal(f.calls.toasts.length, 0);
  const retry = f.shop.ensureLogin(); await tick(); await f.finishLogin(); await retry;
  assert.equal(f.calls.logins.length, 2);
});

test('app and free home page do not prepare identity or send requests', () => {
  const f = fixture(); f.load('app.js'); f.page('pages/home/index.js').onLoad();
  assert.equal(f.calls.logins.length, 0); assert.equal(f.calls.requests.length, 0);
});

test('entry does not log in when order service is disabled', async () => {
  const f = fixture({ ordersEnabled: false }); f.page().onLoad(); await tick();
  assert.equal(f.calls.logins.length, 0);
  assert.equal(f.calls.requests.length, 1, 'only the public catalog is requested');
});

test('entry, selection and rapid confirmation share one login and checkout preparation', async () => {
  const f = fixture();
  const login = f.shop.ensureLogin({ checkWechat: true });
  const preparing = f.pay.preparePurchase(plan());
  const creating = f.pay.createOrder(plan()); await tick();
  assert.equal(f.calls.logins.length, 1); assert.equal(f.pending('checkout-id').length, 1);
  f.reply(f.pending('checkout-id')[0], { checkout_id: 'synthetic-one' }); await f.finishLogin(); await login; await tick();
  assert.equal(f.pending('orders').length, 1);
  assert.equal(f.pending('orders')[0].data.checkout_id, 'synthetic-one');
  assert.equal(f.storage.get('sparkwish:checkout-attempt').checkoutID, 'synthetic-one');
  f.reply(f.pending('orders')[0], { id: 'SYNTHETIC-ORDER', query_code: 'SYNTHETIC-QUERY' }); await Promise.all([preparing, creating]);
});

test('a superseded selection cannot overwrite the current saved attempt', async () => {
  const f = fixture(); await f.authenticated();
  const first = f.pay.preparePurchase(plan('synthetic-a'));
  const second = f.pay.preparePurchase(plan('synthetic-b')); await tick();
  const [a, b] = f.pending('checkout-id');
  f.reply(b, { checkout_id: 'synthetic-b-checkout' }); await second;
  f.reply(a, { checkout_id: 'synthetic-a-checkout' }); await first;
  assert.equal(f.storage.get('sparkwish:checkout-attempt').planID, 'synthetic-b');
});

test('reselecting a saved attempt also prevents another selection from overwriting it', async () => {
  const f = fixture(); await f.authenticated(); f.storage.set('sparkwish:checkout-attempt', attempt('synthetic-a'));
  const pending = f.pay.preparePurchase(plan('synthetic-b')); await tick();
  await f.pay.preparePurchase(plan('synthetic-a'));
  f.reply(f.pending('checkout-id')[0], { checkout_id: 'synthetic-other' }); await pending;
  assert.equal(f.storage.get('sparkwish:checkout-attempt').planID, 'synthetic-a');
});

test('an unknown create result retries the original checkout instead of allocating another', async () => {
  const f = fixture(); await f.authenticated();
  const creating = f.pay.createOrder(plan()); const rejected = assert.rejects(creating, error => error.code === 'network_unknown'); await tick();
  f.reply(f.pending('checkout-id')[0], { checkout_id: 'synthetic-original' }); await tick();
  f.fail(f.pending('orders')[0]); await rejected;
  const retry = f.pay.createOrder(plan()); await tick();
  assert.equal(f.calls.requests.filter(r => r.path === 'checkout-id').length, 1);
  assert.equal(f.pending('orders')[0].data.checkout_id, 'synthetic-original');
  f.reply(f.pending('orders')[0], { id: 'SYNTHETIC-ORDER' }); await retry;
});

test('checkout read/write failures block order creation without clearing original data', async () => {
  for (const mode of ['read', 'write']) {
    const f = fixture(); await f.authenticated();
    if (mode === 'read') f.storage.set('sparkwish:checkout-attempt', attempt());
    f.faults[mode] = true;
    const creating = f.pay.createOrder(plan()); const rejected = assert.rejects(creating, error => error.code === 'attempt_storage_unavailable'); await tick();
    if (mode === 'write') f.reply(f.pending('checkout-id')[0], { checkout_id: 'synthetic-one' });
    await rejected; assert.equal(f.pending('orders').length, 0);
    if (mode === 'read') assert.equal(f.storage.get('sparkwish:checkout-attempt').checkoutID, 'synthetic-original');
  }
});

test('a late completed order cannot clear another purchases saved recovery attempt', async () => {
  const f = fixture(); await f.authenticated(); f.storage.set('sparkwish:checkout-attempt', attempt('synthetic-a'));
  const creating = f.pay.createOrder(plan('synthetic-a')); await tick();
  const preparing = f.pay.preparePurchase(plan('synthetic-b')); await tick();
  f.reply(f.pending('checkout-id')[0], { checkout_id: 'synthetic-b-checkout' }); await preparing;
  f.reply(f.pending('orders')[0], { id: 'SYNTHETIC-ORDER-A' }); await creating;
  assert.equal(f.storage.get('sparkwish:checkout-attempt').checkoutID, 'synthetic-b-checkout');
});

test('an incomplete order response preserves its original recovery attempt', async () => {
  const f = fixture(); await f.authenticated(); f.storage.set('sparkwish:checkout-attempt', attempt());
  const creating = f.pay.createOrder(plan()); const rejected = assert.rejects(creating, /订单结果暂未确认/); await tick();
  f.reply(f.pending('orders')[0], {}); await rejected;
  assert.equal(f.storage.get('sparkwish:checkout-attempt').checkoutID, 'synthetic-original');
});

test('order submission uses the prepared parameter snapshot even if the selected object changes', async () => {
  const f = fixture(); await f.authenticated(); f.storage.set('sparkwish:checkout-attempt', attempt());
  const selected = plan(), creating = f.pay.createOrder(selected);
  selected.id = 'synthetic-changed'; selected.version = 9; await tick();
  const request = f.pending('orders')[0];
  assert.equal(request.data.plan_id, 'synthetic-plan'); assert.equal(request.data.plan_version, 1);
  f.reply(request, { id: 'SYNTHETIC-ORDER' }); await creating;
});

test('malformed saved attempts fail closed instead of replacing the recovery identifier', async () => {
  const f = fixture(); f.storage.set('sparkwish:checkout-attempt', { checkoutID: 'synthetic-incomplete' });
  const creating = f.pay.createOrder(plan()); const rejected = assert.rejects(creating, error => error.code === 'attempt_storage_unavailable');
  await tick(); await f.finishLogin(); await rejected;
  assert.equal(f.pending('checkout-id').length, 0); assert.equal(f.pending('orders').length, 0);
});

test('payment checks and reuses a valid login without a second code exchange', async () => {
  const f = fixture(); await f.authenticated();
  const paying = f.shop.payOrder('SYNTHETIC-QUERY'); await f.approveCheck();
  assert.equal(f.calls.logins.length, 1);
  assert.equal(f.pending('orders/pay')[0].header.Authorization, 'Bearer ' + token(1));
  f.reply(f.pending('orders/pay')[0], parameters); await paying;
});

test('expired WeChat session triggers one new login before payment parameters', async () => {
  const f = fixture(); await f.authenticated();
  const paying = f.shop.payOrder('SYNTHETIC-QUERY'); await tick(); f.calls.checks[0].fail({}); await tick();
  assert.equal(f.pending('orders/pay').length, 0); await f.finishLogin(2);
  assert.equal(f.pending('orders/pay')[0].header.Authorization, 'Bearer ' + token(2));
  f.reply(f.pending('orders/pay')[0], parameters); await paying;
  assert.equal(f.calls.logins.length, 2);
});

test('missing or stalled native session checks fall back to a new login', async () => {
  for (const mode of ['missing', 'stalled']) {
    const f = fixture(); await f.authenticated();
    if (mode === 'missing') f.wx.checkSession = undefined;
    const paying = f.shop.payOrder('SYNTHETIC-QUERY'); await tick();
    if (mode === 'stalled') { for (const timer of [...f.timers.values()]) timer.callback(); await tick(); }
    await f.finishLogin(2);
    assert.equal(f.pending('orders/pay')[0].header.Authorization, 'Bearer ' + token(2));
    f.reply(f.pending('orders/pay')[0], parameters); await paying;
    assert.equal(f.calls.logins.length, 2);
  }
});

test('local token deadline or clock rollback cannot indefinitely reuse the cached token', async () => {
  for (const now of [2000000, 1]) {
    const f = fixture();
    const first = f.shop.ensureLogin(); await tick(); await f.finishLogin(1, 60); await first;
    f.clock.now = now;
    const next = f.shop.ensureLogin(); await tick(); await f.finishLogin(2); await next;
    assert.equal(f.calls.logins.length, 2);
  }
});

test('backend 401 reauthenticates once and retains the original payment query', async () => {
  const f = fixture(); await f.authenticated();
  const paying = f.shop.payOrder('SYNTHETIC-QUERY'); await f.approveCheck();
  f.reply(f.pending('orders/pay')[0], null, 401); await tick(); await f.finishLogin(2);
  const retry = f.pending('orders/pay')[0];
  assert.equal(retry.data.query_code, 'SYNTHETIC-QUERY'); assert.equal(retry.header.Authorization, 'Bearer ' + token(2));
  f.reply(retry, parameters); await paying;
  assert.equal(f.calls.requests.filter(r => r.path === 'orders/pay').length, 2);
});

test('a second 401 stops instead of entering an authentication retry loop', async () => {
  const f = fixture(); await f.authenticated();
  const paying = f.shop.payOrder('SYNTHETIC-QUERY'); const rejected = assert.rejects(paying, error => error.status === 401);
  await f.approveCheck(); f.reply(f.pending('orders/pay')[0], null, 401); await tick(); await f.finishLogin(2);
  f.reply(f.pending('orders/pay')[0], null, 401); await rejected;
  assert.equal(f.calls.logins.length, 2); assert.equal(f.calls.requests.filter(r => r.path === 'orders/pay').length, 2);
});

test('create-order authentication recovery retains the saved checkout and original parameters', async () => {
  const f = fixture(); await f.authenticated(); f.storage.set('sparkwish:checkout-attempt', attempt());
  const creating = f.pay.createOrder(plan()); await tick();
  const original = f.pending('orders')[0];
  f.reply(original, null, 401); await tick(); await f.finishLogin(2);
  const retry = f.pending('orders')[0];
  assert.deepEqual(retry.data, original.data);
  assert.equal(f.calls.requests.filter(r => r.path === 'checkout-id').length, 0);
  f.reply(retry, { id: 'SYNTHETIC-ORDER' }); await creating;
});

test('create failure clears loading while retaining the recovery attempt', async () => {
  const f = fixture(); await f.authenticated(); f.storage.set('sparkwish:checkout-attempt', attempt());
  const page = f.page(), creating = page.startPurchase(plan()); await tick();
  f.fail(f.pending('orders')[0]); await creating;
  assert.equal(f.loadingVisible, false); assert.equal(page.paying, false);
  assert.equal(f.storage.get('sparkwish:checkout-attempt').checkoutID, 'synthetic-original');
  assert.equal(f.calls.payments.length, 0); assert.equal(f.calls.navigation.length, 0);
});

test('network or backend storage failures do not trigger reauthentication or a second payment request', async () => {
  for (const mode of ['network', 'server']) {
    const f = fixture(); await f.authenticated();
    const paying = f.shop.payOrder('SYNTHETIC-QUERY'); const rejected = assert.rejects(paying);
    await f.approveCheck();
    if (mode === 'network') f.fail(f.pending('orders/pay')[0]); else f.reply(f.pending('orders/pay')[0], null, 503);
    await rejected;
    assert.equal(f.calls.logins.length, 1); assert.equal(f.calls.requests.filter(r => r.path === 'orders/pay').length, 1);
    assert.equal(f.calls.payments.length, 0);
  }
});

test('a late 401 for an old token reuses an already completed newer login', async () => {
  const f = fixture(); await f.authenticated();
  const reading = f.shop.fetchOrders(); await tick(); const oldRequest = f.pending('mini/orders')[0];
  const newer = f.shop.ensureLogin({ force: true }); await tick(); await f.finishLogin(2); await newer;
  f.reply(oldRequest, null, 401); await tick();
  assert.equal(f.calls.logins.length, 2);
  assert.equal(f.pending('mini/orders')[0].header.Authorization, 'Bearer ' + token(2));
  f.reply(f.pending('mini/orders')[0], []); await reading;
});

test('force refresh arriving during a session check joins the same renewed login', async () => {
  const f = fixture(); await f.authenticated();
  const checked = f.shop.ensureLogin({ checkWechat: true }); await tick();
  const forced = f.shop.ensureLogin({ force: true });
  assert.equal(checked, forced);
  f.calls.checks[0].success({}); await tick(); await f.finishLogin(2);
  assert.equal(await checked, token(2)); assert.equal(f.calls.logins.length, 2);
});

test('invalid backend login response cannot become a cached session', async () => {
  const f = fixture(); const login = f.shop.ensureLogin(); const rejected = assert.rejects(login, error => error.code === 'login_failed'); await tick();
  f.calls.logins[0].done = true; f.calls.logins[0].success({ code: 'synthetic-code' }); await tick();
  f.reply(f.pending('mini/login')[0], { token: 'invalid', expires_in: 604800 }); await rejected;
  const retry = f.shop.ensureLogin(); await tick(); await f.finishLogin(2); await retry;
  assert.equal(f.calls.logins.length, 2);
});

test('loading feedback spans order creation and payment parameters, then ends before native payment', async () => {
  const f = fixture(); await f.authenticated(); f.storage.set('sparkwish:checkout-attempt', attempt());
  const page = f.page(), purchase = page.startPurchase(plan()); await tick();
  assert.equal(f.loadingVisible, true);
  f.reply(f.pending('orders')[0], { id: 'SYNTHETIC-ORDER', query_code: 'SYNTHETIC-QUERY' }); await tick();
  assert.equal(f.loadingVisible, true); assert.equal(f.calls.events.filter(e => e.kind === 'hide').length, 0);
  assert.equal(f.calls.events.at(-1).title, '正在准备支付');
  await f.approveCheck(); f.reply(f.pending('orders/pay')[0], parameters); await tick();
  assert.equal(f.calls.payments.length, 1); assert.equal(f.loadingVisible, false);
  assert.equal(f.calls.events.find(e => e.kind === 'native-pay').loadingVisible, false);
  f.calls.payments[0].success({}); await purchase; await tick();
  assert.equal(f.pending('orders/sync').length, 1);
  assert.equal(f.calls.navigation.length, 1); assert.equal(page.paying, false);
  assert.equal(f.storage.has('sparkwish:checkout-attempt'), false);
  f.reply(f.pending('orders/sync')[0], { order: { id: 'SYNTHETIC-ORDER' } });
});

test('parameter failure ends feedback and opens the existing order without invoking payment', async () => {
  const f = fixture(); await f.authenticated(); f.storage.set('sparkwish:checkout-attempt', attempt());
  const page = f.page(), purchase = page.startPurchase(plan()); await tick();
  f.reply(f.pending('orders')[0], { id: 'SYNTHETIC-ORDER', query_code: 'SYNTHETIC-QUERY' }); await f.approveCheck();
  f.fail(f.pending('orders/pay')[0]); await purchase;
  assert.equal(f.loadingVisible, false); assert.equal(page.paying, false); assert.equal(f.calls.payments.length, 0);
  assert.equal(f.calls.navigation[0], '/pages/pro/order/index?id=SYNTHETIC-ORDER');
});

test('payment cancellation does not automatically invoke payment again or create a new order', async () => {
  const f = fixture(); await f.authenticated();
  const paying = f.pay.payForOrder('SYNTHETIC-QUERY'); const rejected = assert.rejects(paying, error => error.code === 'cancelled');
  await f.approveCheck(); f.reply(f.pending('orders/pay')[0], parameters); await tick();
  f.calls.payments[0].fail({ errMsg: 'requestVirtualPayment:fail cancel' }); await rejected;
  assert.equal(f.calls.payments.length, 1); assert.equal(f.pending('orders').length, 0);
});

test('unknown native payment result is returned without automatic payment retry', async () => {
  const f = fixture(); await f.authenticated();
  const paying = f.pay.payForOrder('SYNTHETIC-QUERY'); const rejected = assert.rejects(paying, error => error.code === 'pay_failed');
  await f.approveCheck(); f.reply(f.pending('orders/pay')[0], parameters); await tick();
  f.calls.payments[0].fail({ errMsg: 'synthetic unknown result' }); await rejected;
  assert.equal(f.calls.payments.length, 1); assert.equal(f.pending('orders').length, 0);
});

test('a departed purchase page cannot open a cashier from a late parameter response', async () => {
  const f = fixture(); await f.authenticated(); f.storage.set('sparkwish:checkout-attempt', attempt());
  const page = f.page(), purchase = page.startPurchase(plan()); await tick();
  f.reply(f.pending('orders')[0], { id: 'SYNTHETIC-ORDER', query_code: 'SYNTHETIC-QUERY' }); await f.approveCheck();
  page.onUnload(); assert.equal(f.loadingVisible, false);
  f.reply(f.pending('orders/pay')[0], parameters); await purchase;
  assert.equal(f.calls.payments.length, 0); assert.equal(f.calls.navigation.length, 0); assert.equal(f.calls.toasts.length, 0);
});

test('leaving during preparation prevents a late checkout response from creating an order', async () => {
  const f = fixture(); await f.authenticated();
  const page = f.page(), purchase = page.startPurchase(plan()); await tick();
  page.onUnload(); f.reply(f.pending('checkout-id')[0], { checkout_id: 'synthetic-late' }); await purchase;
  assert.equal(f.pending('orders').length, 0); assert.equal(f.calls.payments.length, 0);
  assert.equal(f.loadingVisible, false); assert.equal(f.calls.toasts.length, 0);
});

test('paid-order filtering and requested detail copy remain precise', () => {
  const f = fixture(), states = f.load('utils/order-state.js');
  const paid = { payment_status: 'paid', delivery_status: 'delivered' };
  assert.equal(states.describe(paid).title, '已交付'); assert.equal(states.describe(paid).hint, '');
  assert.equal(states.describe({ ...paid, delivery_status: 'unknown' }).hint, '请刷新状态，以返回的结果为准。');
  assert.equal(states.describe({ ...paid, delivery_status: 'confirmation_pending' }).hint, '微信侧发货确认仍在处理，请稍后刷新。');
  assert.equal(states.describe({ ...paid, delivery_status: 'pending' }).hint, '正在确认交付结果，请稍后刷新。');
  assert.equal(states.isPaid(paid), true); assert.equal(states.isPaid({ payment_status: 'pending' }), false); assert.equal(states.isPaid({ payment_status: 'closed' }), false);
});

test('the actual order-list page continues to show only confirmed paid orders', async () => {
  const f = fixture(); await f.authenticated();
  const page = f.page('pages/pro/orders/index.js'); page.onLoad(); page.onShow(); await tick();
  f.reply(f.pending('mini/orders')[0], [
    { id: 'SYNTHETIC-PAID', payment_status: 'paid', delivery_status: 'delivered' },
    { id: 'SYNTHETIC-DELIVERING', payment_status: 'paid', delivery_status: 'pending' },
    { id: 'SYNTHETIC-UNPAID', payment_status: 'pending' },
    { id: 'SYNTHETIC-CLOSED', payment_status: 'closed' },
  ]); await tick();
  assert.deepEqual(Array.from(page.data.orders, value => value.id), ['SYNTHETIC-PAID', 'SYNTHETIC-DELIVERING']);
});
