const config = require('../config/shop');
const perf = require('./perf');

const ATTEMPT_KEY = 'sparkwish:checkout-attempt';
const CATALOG_CACHE_KEY = 'sparkwish:catalog-cache';
const CATALOG_TTL = 5 * 60 * 1000;

let session = '';
let loginPromise = null;

function rootURL() {
  const value = String(config.baseURL || '').replace(/\/+$/, '');
  return /^https:\/\//i.test(value) ? value : '';
}

function projectID() {
  return String(config.projectID || '');
}

function catalogReady() {
  return !!rootURL() && !!projectID();
}

function ordersReady() {
  return catalogReady() && config.ordersEnabled === true;
}

function paymentReady() {
  return ordersReady() && config.paymentEnabled === true;
}

function makeError(code, message, status) {
  const error = new Error(message);
  error.code = code;
  error.status = status || 0;
  return error;
}

function request(path, data, token) {
  const root = rootURL();
  if (!root || !projectID()) {
    return Promise.reject(makeError('not_configured', '服务地址或项目标识尚未配置'));
  }
  return new Promise((resolve, reject) => {
    wx.request({
      url: root + '/api/shop/' + path,
      method: data ? 'POST' : 'GET',
      data: data || undefined,
      timeout: config.timeout || 15000,
      header: Object.assign(
        { 'Content-Type': 'application/json' },
        token ? { Authorization: 'Bearer ' + token } : {}
      ),
      success(res) {
        const body = res.data;
        if (res.statusCode >= 200 && res.statusCode < 300 && body && body.code === 0) {
          resolve(body.data);
          return;
        }
        const message = (body && body.message) || '服务暂不可用，请稍后重试';
        reject(makeError((body && body.error) || 'request_failed', message, res.statusCode));
      },
      fail() {
        reject(makeError('network_unknown', '网络暂未确认，请保留原订单后重试'));
      },
    });
  });
}

function login(options) {
  if (options && options.force) session = '';
  if (session) return Promise.resolve(session);
  if (loginPromise) return loginPromise;
  perf.mark('login_start');
  loginPromise = new Promise((resolve, reject) => {
    wx.login({
      success(res) {
        if (res && res.code) resolve(res.code);
        else reject(makeError('login_failed', '微信身份验证失败，请重新进入'));
      },
      fail() {
        reject(makeError('login_failed', '微信身份验证暂不可用'));
      },
    });
  })
    .then((code) => {
      perf.mark('wx_login_done');
      return request('mini/login', { code });
    })
    .then((data) => {
      session = (data && data.token) || '';
      loginPromise = null;
      perf.mark('mp_login_done');
      return session;
    })
    .catch((error) => {
      loginPromise = null;
      throw error;
    });
  return loginPromise;
}

function withSession(path, data, options) {
  return login(options).then((token) =>
    request(path, data, token).catch((error) => {
      if (error.status !== 401) throw error;
      session = '';
      return login({ force: true }).then((next) => request(path, data, next));
    })
  );
}

function loadCatalogCache() {
  try {
    const cached = wx.getStorageSync(CATALOG_CACHE_KEY);
    if (
      cached &&
      Array.isArray(cached.plans) &&
      typeof cached.savedAt === 'number' &&
      Date.now() - cached.savedAt < CATALOG_TTL
    ) {
      return cached;
    }
  } catch (e) {
  }
  return null;
}

function saveCatalogCache(plans) {
  if (!Array.isArray(plans) || !plans.length) return;
  try {
    wx.setStorageSync(CATALOG_CACHE_KEY, { plans, savedAt: Date.now() });
  } catch (e) {
  }
}

function fetchCatalog() {
  const id = projectID();
  if (!catalogReady()) return Promise.reject(makeError('not_configured', '服务地址或项目标识尚未配置'));
  return request('catalog?app_id=' + encodeURIComponent(id)).then((data) => {
    saveCatalogCache((data && data.plans) || []);
    return data;
  });
}

function fetchOrders() {
  if (!ordersReady()) {
    return Promise.reject(makeError('orders_not_enabled', '订单服务暂未接入'));
  }
  return withSession('mini/orders');
}

function newCheckoutID() {
  if (!ordersReady()) {
    return Promise.reject(makeError('orders_not_enabled', '订单服务暂未接入'));
  }
  perf.mark('checkout_id_start');
  return request('checkout-id', {}).then((data) => {
    perf.mark('checkout_id_done');
    return data;
  });
}

function saveAttempt(attempt) {
  try {
    wx.setStorageSync(ATTEMPT_KEY, {
      projectID: attempt.projectID,
      planID: attempt.planID,
      planVersion: attempt.planVersion,
      checkoutID: attempt.checkoutID,
    });
  } catch (e) {
  }
}

function loadAttempt() {
  try {
    return wx.getStorageSync(ATTEMPT_KEY) || null;
  } catch (e) {
    return null;
  }
}

function clearAttempt() {
  try {
    wx.removeStorageSync(ATTEMPT_KEY);
  } catch (e) {
  }
}

function createOrder(input) {
  if (!ordersReady()) {
    return Promise.reject(makeError('orders_not_enabled', '订单服务暂未接入'));
  }
  perf.mark('create_order_start');
  return withSession('orders', {
    app_id: input.projectID || projectID(),
    plan_id: input.planID,
    plan_version: input.planVersion,
    checkout_id: input.checkoutID,
    payment_method: input.paymentMethod || config.paymentMethod || 'virtual',
    qq: input.qq || '',
    email: input.email || '',
  }).then((data) => {
    perf.mark('create_order_done');
    return data;
  });
}

function payOrder(queryCode) {
  if (!paymentReady()) {
    return Promise.reject(makeError('payment_not_enabled', '支付暂未开放'));
  }
  return withSession('orders/pay', { query_code: queryCode }, { force: true });
}

function queryOrder(queryCode) {
  if (!ordersReady()) {
    return Promise.reject(makeError('orders_not_enabled', '订单服务暂未接入'));
  }
  return withSession('orders/query', { query_code: queryCode });
}

function syncOrder(queryCode) {
  if (!ordersReady()) {
    return Promise.reject(makeError('orders_not_enabled', '订单服务暂未接入'));
  }
  return withSession('orders/sync', { query_code: queryCode });
}

module.exports = {
  catalogReady,
  ordersReady,
  paymentReady,
  loadCatalogCache,
  fetchCatalog,
  fetchOrders,
  newCheckoutID,
  ensureLogin: login,
  createOrder,
  payOrder,
  queryOrder,
  syncOrder,
  saveAttempt,
  loadAttempt,
  clearAttempt,
};
