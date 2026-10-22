// 中枢购买服务对接层。
// 只封装只读目录与订单相关接口；地址或项目未配置时直接拒绝，不发起请求。
// 会话令牌只保存在内存，私密查询号、卡密不写入本地缓存、页面路径或日志。
const config = require('../config/shop');

const ATTEMPT_KEY = 'sparkwish:checkout-attempt';

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
        // 结果未知：调用方保留原订单，仅重试查询，不能据此判定订单失败。
        reject(makeError('network_unknown', '网络暂未确认，请保留原订单后重试'));
      },
    });
  });
}

// force=true 时丢弃当前令牌重新换取，用于支付前刷新身份。
function login(options) {
  if (options && options.force) session = '';
  if (session) return Promise.resolve(session);
  if (loginPromise) return loginPromise;
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
    .then((code) => request('mini/login', { code }))
    .then((data) => {
      session = (data && data.token) || '';
      loginPromise = null;
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

// 公开套餐目录，不需要登录。
function fetchCatalog() {
  const id = projectID();
  if (!catalogReady()) return Promise.reject(makeError('not_configured', '服务地址或项目标识尚未配置'));
  return request('catalog?app_id=' + encodeURIComponent(id));
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
  return request('checkout-id', {});
}

// 下单请求只保存恢复原订单所需的最小字段，不含令牌、查询号与卡密。
function saveAttempt(attempt) {
  try {
    wx.setStorageSync(ATTEMPT_KEY, {
      projectID: attempt.projectID,
      planID: attempt.planID,
      planVersion: attempt.planVersion,
      checkoutID: attempt.checkoutID,
    });
  } catch (e) {
    // 本地缓存失败不影响下单；恢复时重新取号即可。
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
    // 忽略缓存清理失败。
  }
}

function createOrder(input) {
  if (!ordersReady()) {
    return Promise.reject(makeError('orders_not_enabled', '订单服务暂未接入'));
  }
  return withSession('orders', {
    app_id: input.projectID || projectID(),
    plan_id: input.planID,
    plan_version: input.planVersion,
    checkout_id: input.checkoutID,
    payment_method: input.paymentMethod || config.paymentMethod || 'virtual',
    qq: input.qq || '',
    email: input.email || '',
  });
}

// 支付前按文档要求重新换取身份，再申请支付参数。
function payOrder(queryCode) {
  if (!paymentReady()) {
    return Promise.reject(makeError('payment_not_enabled', '支付暂未开放'));
  }
  return withSession('orders/pay', { query_code: queryCode }, { force: true });
}

// 只读取订单，不触发中枢核对。
function queryOrder(queryCode) {
  if (!ordersReady()) {
    return Promise.reject(makeError('orders_not_enabled', '订单服务暂未接入'));
  }
  return withSession('orders/query', { query_code: queryCode });
}

// 请中枢核对支付，是唯一可信的付款确认方式。
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
  fetchCatalog,
  fetchOrders,
  newCheckoutID,
  createOrder,
  payOrder,
  queryOrder,
  syncOrder,
  saveAttempt,
  loadAttempt,
  clearAttempt,
};
