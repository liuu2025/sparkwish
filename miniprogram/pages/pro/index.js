const config = require('../../config/shop');
const shop = require('../../utils/shop');
const pay = require('../../utils/pay');
const verify = require('../../utils/verify');
const perf = require('../../utils/perf');
const { formatAmount } = require('../../utils/order-state');

function toPlanView(plan) {
  const purchasable = config.paymentEnabled === true && plan.mini_ready !== false;
  let buyHint = '';
  if (config.paymentEnabled !== true) {
    buyHint = '购买功能暂未开放，支付联调完成后开放。';
  } else if (plan.mini_ready === false) {
    buyHint = '该套餐暂不可购买。';
  }
  return {
    id: plan.id,
    version: plan.version,
    name: plan.name,
    price: formatAmount(plan.price_cents),
    description: plan.description || '',
    purchasable,
    buyHint,
  };
}

function orderPlans(plans) {
  const wanted = Array.isArray(config.planIDs) ? config.planIDs : [];
  if (!wanted.length) return plans;
  const result = [];
  for (let i = 0; i < wanted.length; i += 1) {
    for (let j = 0; j < plans.length; j += 1) {
      if (plans[j].id === wanted[i]) {
        result.push(plans[j]);
        break;
      }
    }
  }
  for (let i = 0; i < plans.length; i += 1) {
    if (wanted.indexOf(plans[i].id) < 0) result.push(plans[i]);
  }
  return result;
}

Page({
  data: {
    catalogReady: false,
    loading: false,
    refreshing: false,
    failed: false,
    errorText: '',
    plans: [],
  },

  onLoad() {
    this.catalogDisposed = false;
    if (!shop.catalogReady()) {
      this.setData({ catalogReady: false });
      return;
    }
    this.setData({ catalogReady: true });
    // Prepare identity without delaying catalog rendering or creating an order.
    if (shop.ordersReady()) shop.ensureLogin({ checkWechat: true }).catch(() => null);
    const cached = shop.loadCatalogCache();
    if (cached) {
      this.setData({ plans: orderPlans(cached.plans).map(toPlanView) });
      this.load(true);
    } else {
      this.load();
    }
  },

  load(silent) {
    if (this.loading) return;
    this.loading = true;
    const hasPlans = this.data.plans.length > 0;
    this.setData({ loading: !hasPlans, refreshing: true, failed: false, errorText: '' });
    return shop
      .fetchCatalog()
      .then((data) => {
        if (this.catalogDisposed) return;
        this.setData({
          plans: orderPlans((data && data.plans) || []).map(toPlanView),
        });
        if (!silent && hasPlans) {
          wx.showToast({ title: '套餐已更新', icon: 'success', duration: 1500 });
        }
      })
      .catch((error) => {
        if (this.catalogDisposed) return;
        if (hasPlans) {
          if (!silent) {
            wx.showToast({ title: '刷新失败，请稍后重试', icon: 'none', duration: 2000 });
          }
        } else {
          this.setData({
            failed: true,
            errorText: error && error.message ? error.message : '服务暂不可用，请稍后重试',
          });
        }
      })
      .then(() => {
        this.loading = false;
        if (!this.catalogDisposed) this.setData({ loading: false, refreshing: false });
      });
  },

  onRetry() {
    if (!this.data.catalogReady) return;
    return this.load();
  },

  onUnload() {
    this.catalogDisposed = true;
    this.hidePurchaseLoading();
  },

  onBuy(e) {
    const id = e.currentTarget.dataset.id;
    const plan = this.data.plans.find((item) => item.id === id);
    if (!plan || !plan.purchasable) {
      wx.showToast({
        title: (plan && plan.buyHint) || '当前暂不可购买',
        icon: 'none',
        duration: 2000,
      });
      return;
    }
    if (this.paying || this.confirming) return;
    this.confirming = true;
    perf.mark('buy_tap');
    // 弹窗展示期间提前准备下单编号与登录，确认后直接复用。
    pay.preparePurchase(plan);
    this.setData({ confirmPlan: plan });
  },

  onConfirmBuy() {
    const plan = this.data.confirmPlan;
    if (!plan || this.paying) return;
    perf.mark('buy_confirm');
    this.setData({ confirmPlan: null });
    this.confirming = false;
    this.startPurchase(plan);
  },

  onCancelBuy() {
    if (!this.data.confirmPlan) return;
    this.setData({ confirmPlan: null });
    this.confirming = false;
  },

  noop() {
    // 阻止点击弹窗内容冒泡到遮罩层关闭弹窗。
  },

  startPurchase(plan) {
    if (this.paying) return;
    this.paying = true;
    this.showPurchaseLoading('正在准备订单');

    return pay
      .createOrder(plan, {
        beforeSubmit: () => {
          if (this.catalogDisposed) throw new Error('购买页面已关闭');
        },
      })
      .then((order) => {
        if (this.catalogDisposed) return null;
        const orderID = (order && order.id) || '';
        const queryCode = (order && order.query_code) || '';
        if (!queryCode) {
          this.hidePurchaseLoading();
          this.openOrder(orderID);
          return null;
        }
        // 支付结果无论是成功、取消还是失败，都进入订单页：
        // 状态一律由中枢核实结果决定，客户端回调不判定付款成败。
        this.showPurchaseLoading('正在准备支付');
        return pay
          .payForOrder(queryCode, {
            beforeInvoke: () => {
              if (this.catalogDisposed) throw new Error('购买页面已关闭');
              this.hidePurchaseLoading();
            },
          })
          .then(() => {
            if (this.catalogDisposed) return;
            // 全流程唯一一次核实，在进入订单页前发起，订单页等待同一次结果。
            verify.begin(queryCode, order);
            this.openOrder(orderID);
          })
          .catch((error) => {
            this.hidePurchaseLoading();
            if (this.catalogDisposed) return;
            wx.showToast({
              title: (error && error.message) || '支付未完成，可在订单详情重试',
              icon: 'none',
              duration: 2200,
            });
            this.openOrder(orderID);
          });
      })
      .catch((error) => {
        this.hidePurchaseLoading();
        if (this.catalogDisposed) return;
        wx.showToast({
          title: (error && error.message) || '下单失败，请稍后重试',
          icon: 'none',
          duration: 2200,
        });
      })
      .then(() => {
        this.hidePurchaseLoading();
        this.paying = false;
      });
  },

  showPurchaseLoading(title) {
    this.purchaseLoading = true;
    wx.showLoading({ title, mask: true });
  },

  hidePurchaseLoading() {
    if (!this.purchaseLoading) return;
    this.purchaseLoading = false;
    wx.hideLoading();
  },

  openOrder(orderID) {
    if (!orderID) return;
    wx.navigateTo({
      url: '/pages/pro/order/index?id=' + encodeURIComponent(orderID),
      fail: () => {
        wx.showToast({ title: '订单详情打开失败，请到“我的订单”查看', icon: 'none' });
      },
    });
  },

  onOrders() {
    wx.navigateTo({
      url: '/pages/pro/orders/index',
      fail: () => {
        wx.showToast({ title: '页面打开失败，请重试', icon: 'none' });
      },
    });
  },
});
