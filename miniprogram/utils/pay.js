const config = require('../config/shop');
const shop = require('./shop');
const perf = require('./perf');

function ensureCheckout(plan) {
  const saved = shop.loadAttempt();
  const reusable =
    saved &&
    saved.checkoutID &&
    saved.projectID === config.projectID &&
    saved.planID === plan.id &&
    Number(saved.planVersion) === Number(plan.version);

  if (reusable) return Promise.resolve(saved);

  return shop.newCheckoutID().then((data) => {
    const checkoutID = data && data.checkout_id;
    if (!checkoutID) throw new Error('下单编号获取失败，请稍后重试');
    const attempt = {
      projectID: config.projectID,
      planID: plan.id,
      planVersion: plan.version,
      checkoutID,
    };
    shop.saveAttempt(attempt);
    return attempt;
  });
}

function createOrder(plan) {
  if (!plan || !plan.id) {
    return Promise.reject(new Error('套餐信息不完整，请返回后重试'));
  }
  // 下单编号与消费者登录无依赖，并行准备；登录内部有去重，不会重复登录。
  return Promise.all([ensureCheckout(plan), shop.ensureLogin()])
    .then((results) => {
      const attempt = results[0];
      return shop.createOrder({
        planID: plan.id,
        planVersion: plan.version,
        checkoutID: attempt.checkoutID,
      });
    });
}

// 提前准备下单编号与登录会话，供确认弹窗展示期间并行完成；
// 结果由 ensureCheckout/saveAttempt 复用，不会产生第二个编号。
function preparePurchase(plan) {
  if (!plan || !plan.id) return Promise.resolve(null);
  return Promise.all([ensureCheckout(plan), shop.ensureLogin()])
    .then(() => null)
    .catch(() => null);
}

function requestPayment(virtualPayment) {
  return new Promise((resolve, reject) => {
    if (!virtualPayment) {
      reject(new Error('支付参数缺失，请稍后重试'));
      return;
    }
    if (typeof wx.requestVirtualPayment !== 'function') {
      reject(new Error('当前微信版本不支持小程序虚拟支付，请升级微信后重试'));
      return;
    }
    wx.requestVirtualPayment(
      Object.assign({}, virtualPayment, {
        success() {
          resolve();
        },
        fail(res) {
          const message = (res && (res.errMsg || res.errMessage)) || '';
          const error = new Error(/cancel/i.test(message) ? '已取消支付' : '支付未完成');
          error.code = /cancel/i.test(message) ? 'cancelled' : 'pay_failed';
          reject(error);
        },
      })
    );
  });
}

// 仅获取支付参数（orders/pay），不拉起收银台。
function fetchPayParams(queryCode) {
  if (!queryCode) return Promise.reject(new Error('订单查询号缺失，请刷新后重试'));
  perf.mark('pay_params_start');
  return shop.payOrder(queryCode).then((data) => {
    perf.mark('pay_params_done');
    return data && data.virtual_payment;
  });
}

// 获取参数并拉起微信收银台。
function payForOrder(queryCode) {
  return fetchPayParams(queryCode).then((virtualPayment) => {
    perf.mark('pay_invoke');
    return requestPayment(virtualPayment).then(() => {
      perf.mark('pay_callback');
    });
  });
}

module.exports = {
  createOrder,
  preparePurchase,
  requestPayment,
  fetchPayParams,
  payForOrder,
};
