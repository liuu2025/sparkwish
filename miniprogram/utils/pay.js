const config = require('../config/shop');
const shop = require('./shop');

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
  return ensureCheckout(plan).then((attempt) =>
    shop.createOrder({
      planID: plan.id,
      planVersion: plan.version,
      checkoutID: attempt.checkoutID,
    })
  );
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

function payForOrder(queryCode) {
  if (!queryCode) return Promise.reject(new Error('订单查询号缺失，请刷新后重试'));
  return shop.payOrder(queryCode).then((data) => requestPayment(data && data.virtual_payment));
}

module.exports = {
  createOrder,
  requestPayment,
  payForOrder,
};
