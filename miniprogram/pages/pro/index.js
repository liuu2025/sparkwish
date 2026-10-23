const config = require('../../config/shop');
const shop = require('../../utils/shop');
const pay = require('../../utils/pay');
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
    failed: false,
    errorText: '',
    plans: [],
  },

  onLoad() {
    if (!shop.catalogReady()) {
      this.setData({ catalogReady: false });
      return;
    }
    this.setData({ catalogReady: true });
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
    this.setData(silent ? {} : { loading: true, failed: false, errorText: '' });
    shop
      .fetchCatalog()
      .then((data) => {
        this.setData({
          plans: orderPlans((data && data.plans) || []).map(toPlanView),
          loading: false,
        });
      })
      .catch((error) => {
        if (!silent) {
          this.setData({
            loading: false,
            failed: true,
            errorText: error && error.message ? error.message : '服务暂不可用，请稍后重试',
          });
        }
      })
      .then(() => {
        this.loading = false;
      });
  },

  onRetry() {
    if (!this.data.catalogReady) return;
    this.load();
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
    if (this.paying) return;
    this.paying = true;
    wx.showLoading({ title: '正在下单', mask: true });

    pay
      .createOrder(plan)
      .then((order) => {
        wx.hideLoading();
        shop.clearAttempt();
        const orderID = (order && order.id) || '';
        const queryCode = (order && order.query_code) || '';
        if (!queryCode) {
          this.openOrder(orderID);
          return null;
        }
        return pay
          .payForOrder(queryCode)
          .then(() => shop.syncOrder(queryCode).catch(() => {}))
          .catch((error) => {
            wx.showToast({
              title: (error && error.message) || '支付未完成，可在订单详情重试',
              icon: 'none',
              duration: 2200,
            });
          })
          .then(() => this.openOrder(orderID));
      })
      .catch((error) => {
        wx.hideLoading();
        wx.showToast({
          title: (error && error.message) || '下单失败，请稍后重试',
          icon: 'none',
          duration: 2200,
        });
      })
      .then(() => {
        this.paying = false;
      });
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
