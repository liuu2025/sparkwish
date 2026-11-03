const config = require('../config/shop');
const shop = require('./shop');
const perf = require('./perf');

let checkoutFlight = null;

function ensureCheckout(plan) {
  const projectID = config.projectID;
  const planID = plan.id;
  const planVersion = Number(plan.version);
  const key = JSON.stringify([projectID, planID, planVersion]);
  if (checkoutFlight && checkoutFlight.key === key) return checkoutFlight.promise;

  let saved;
  try {
    saved = shop.loadAttempt();
  } catch (error) {
    return Promise.reject(error);
  }
  const reusable =
    saved &&
    saved.checkoutID &&
    saved.projectID === projectID &&
    saved.planID === planID &&
    Number(saved.planVersion) === planVersion;

  if (reusable) {
    // Selecting an existing attempt also supersedes other pending preparations.
    checkoutFlight = null;
    return Promise.resolve(saved);
  }

  const flight = { key, promise: null };
  checkoutFlight = flight;
  flight.promise = Promise.resolve()
    .then(() => shop.newCheckoutID())
    .then((data) => {
      const checkoutID = data && data.checkout_id;
      if (typeof checkoutID !== 'string' || !checkoutID) throw new Error('下单编号获取失败，请稍后重试');
      const attempt = { projectID, planID, planVersion, checkoutID };
      // A cancelled selection's late response cannot overwrite the new attempt.
      if (checkoutFlight === flight) shop.saveAttempt(attempt);
      return attempt;
    })
    .then((attempt) => {
      if (checkoutFlight === flight) checkoutFlight = null;
      return attempt;
    }, (error) => {
      if (checkoutFlight === flight) checkoutFlight = null;
      throw error;
    });
  return flight.promise;
}

function createOrder(plan, options) {
  if (!plan || !plan.id) {
    return Promise.reject(new Error('套餐信息不完整，请返回后重试'));
  }
  // 下单编号与消费者登录无依赖，并行准备；登录内部有去重，不会重复登录。
  return Promise.all([ensureCheckout(plan), shop.ensureLogin()])
    .then((results) => {
      const attempt = results[0];
      if (options && options.beforeSubmit) options.beforeSubmit();
      return shop.createOrder({
        projectID: attempt.projectID,
        planID: attempt.planID,
        planVersion: attempt.planVersion,
        checkoutID: attempt.checkoutID,
      }).then((order) => {
        if (!order || typeof order.id !== 'string' || !order.id) {
          throw new Error('订单结果暂未确认，请保留原下单信息后重试');
        }
        // Only this confirmed attempt may be cleared; another page may already
        // be preparing a different purchase when this response arrives late.
        shop.clearAttempt(attempt.checkoutID);
        return order;
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
function payForOrder(queryCode, options) {
  return fetchPayParams(queryCode).then((virtualPayment) => {
    if (options && options.beforeInvoke) options.beforeInvoke();
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
