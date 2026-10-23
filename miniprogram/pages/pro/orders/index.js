const config = require('../../../config/shop');
const shop = require('../../../utils/shop');
const { describe, isPaid, formatAmount, formatTime } = require('../../../utils/order-state');

const CACHE_KEY = 'sparkwish:orders-cache';

function readCache() {
  try {
    const raw = wx.getStorageSync(CACHE_KEY);
    if (raw && Array.isArray(raw.orders)) return raw;
  } catch (e) {
  }
  return null;
}

function writeCache(orders) {
  try {
    wx.setStorageSync(CACHE_KEY, { savedAt: Date.now(), orders });
  } catch (e) {
  }
}

function toOrderView(order) {
  const state = describe(order, { paymentEnabled: config.paymentEnabled === true });
  const snapshot = order.snapshot || {};
  return {
    id: order.id,
    name: snapshot.name || '套餐',
    price: formatAmount(order.price_cents),
    createdText: formatTime(order.created_at),
    statusTitle: state.title,
    tone: state.tone,
  };
}

Page({
  data: {
    ordersReady: false,
    loading: false,
    failed: false,
    errorText: '',
    orders: [],
  },

  onLoad() {
    this.setData({ ordersReady: shop.ordersReady() });
  },

  onShow() {
    if (!this.data.ordersReady) return;
    this.load();
  },

  load(notify) {
    if (this.loading) return;
    this.loading = true;

    const cached = readCache();
    const hasCache = !!cached;
    this.setData({
      loading: !hasCache,
      failed: false,
      errorText: '',
      orders: hasCache ? cached.orders : this.data.orders,
    });

    shop
      .fetchOrders()
      .then((list) => {
        const orders = (list || []).filter(isPaid).map(toOrderView);
        writeCache(orders);
        this.setData({ orders, loading: false });
        if (notify) {
          wx.showToast({ title: '刷新成功', icon: 'success', duration: 1500 });
        }
      })
      .catch((error) => {
        if (hasCache) {
          this.setData({ loading: false });
          if (notify) {
            wx.showToast({ title: '刷新失败，显示上次结果', icon: 'none', duration: 2000 });
          }
        } else {
          this.setData({
            loading: false,
            failed: true,
            errorText: error && error.message ? error.message : '订单暂时无法获取，请稍后重试',
          });
          if (notify) {
            wx.showToast({ title: '刷新失败，请稍后重试', icon: 'none', duration: 2000 });
          }
        }
      })
      .then(() => {
        this.loading = false;
      });
  },

  onRetry() {
    if (!this.data.ordersReady) return;
    this.load(true);
  },

  onOpen(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({
      url: '/pages/pro/order/index?id=' + encodeURIComponent(id),
      fail: () => {
        wx.showToast({ title: '页面打开失败，请重试', icon: 'none' });
      },
    });
  },
});
