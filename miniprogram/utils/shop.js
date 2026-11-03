const config = require('../config/shop');
const perf = require('./perf');

const ATTEMPT_KEY = 'sparkwish:checkout-attempt';
const CATALOG_CACHE_KEY = 'sparkwish:catalog-cache';
const CATALOG_TTL = 5 * 60 * 1000;

let session = '';
let sessionStartedAt = 0;
let sessionExpiresAt = 0;
let loginFlight = null;

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

function sessionUsable() {
  const now = Date.now();
  return !!session && now >= sessionStartedAt && now < sessionExpiresAt;
}

function clearSession() {
  session = '';
  sessionStartedAt = 0;
  sessionExpiresAt = 0;
}

function checkWechatSession() {
  if (typeof wx.checkSession !== 'function') return Promise.resolve(false);
  return new Promise((resolve) => {
    let finished = false;
    const finish = (valid) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(valid);
    };
    // Native checks must not leave payment preparation waiting indefinitely.
    const timer = setTimeout(() => finish(false), 3000);
    try {
      wx.checkSession({ success: () => finish(true), fail: () => finish(false) });
    } catch (error) {
      finish(false);
    }
  });
}

function renewLogin() {
  clearSession();
  const startedAt = Date.now();
  perf.mark('login_start');
  return new Promise((resolve, reject) => {
    wx.login({
      timeout: config.timeout || 15000,
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
      const token = data && data.token;
      const ttl = Number(data && data.expires_in);
      if (typeof token !== 'string' || !/^[a-f0-9]{64}$/i.test(token) || !Number.isFinite(ttl) || ttl <= 0) {
        throw makeError('login_failed', '微信身份验证未完成，请稍后重试');
      }
      session = token;
      sessionStartedAt = startedAt;
      // Count from request start; the backend remains authoritative on expiry.
      sessionExpiresAt = startedAt + Math.max(0, Math.min(ttl, 604800) * 1000 - 30000);
      perf.mark('mp_login_done');
      return session;
    });
}

function login(options) {
  const settings = options || {};
  // A late 401 for an older token must not invalidate a newer completed login.
  const force = settings.force && (!settings.rejectedToken || !session || session === settings.rejectedToken);
  if (force) {
    clearSession();
    if (loginFlight) loginFlight.force = true;
  }
  if (loginFlight) return loginFlight.promise;
  if (!force && sessionUsable() && !settings.checkWechat) return Promise.resolve(session);

  const flight = { force: !!force, promise: null };
  loginFlight = flight;
  flight.promise = Promise.resolve()
    .then(() => {
      if (flight.force || !sessionUsable()) return renewLogin();
      // All wx.login calls are centralized here. checkSession validates the
      // last obtained code's session_key, which is the one behind this token.
      const checkedToken = session;
      return checkWechatSession().then((valid) => {
        if (valid && !flight.force && checkedToken === session && sessionUsable()) return session;
        return renewLogin();
      });
    })
    .then((token) => {
      if (loginFlight === flight) loginFlight = null;
      return token;
    }, (error) => {
      if (loginFlight === flight) loginFlight = null;
      throw error;
    });
  return flight.promise;
}

function withSession(path, data, options) {
  return login(options).then((token) =>
    request(path, data, token).catch((error) => {
      if (error.status !== 401) throw error;
      return login({ force: true, rejectedToken: token, checkWechat: options && options.checkWechat })
        .then((next) => request(path, data, next));
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
  if (!Array.isArray(plans)) return;
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
    throw makeError('attempt_storage_unavailable', '下单信息暂时无法保存，请稍后重试');
  }
}

function loadAttempt() {
  try {
    const attempt = wx.getStorageSync(ATTEMPT_KEY);
    if (!attempt) return null;
    if (typeof attempt !== 'object' || Array.isArray(attempt) ||
        typeof attempt.checkoutID !== 'string' || !attempt.checkoutID ||
        typeof attempt.projectID !== 'string' || !attempt.projectID ||
        typeof attempt.planID !== 'string' || !attempt.planID ||
        !Number.isSafeInteger(Number(attempt.planVersion)) || Number(attempt.planVersion) <= 0) {
      throw new Error('Invalid checkout attempt');
    }
    return attempt;
  } catch (e) {
    throw makeError('attempt_storage_unavailable', '原下单信息暂时无法读取，请稍后重试');
  }
}

function clearAttempt(checkoutID) {
  try {
    if (checkoutID) {
      const saved = wx.getStorageSync(ATTEMPT_KEY);
      if (!saved || saved.checkoutID !== checkoutID) return;
    }
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
  return withSession('orders/pay', { query_code: queryCode }, { checkWechat: true });
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
