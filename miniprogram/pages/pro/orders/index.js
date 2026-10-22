const config = require('../../../config/shop');
const shop = require('../../../utils/shop');
const { describe, isPaid, formatAmount, formatTime } = require('../../../utils/order-state');

// 只缓存脱敏后的展示字段，不缓存卡密、私密查询号。
const CACHE_KEY = 'sparkwish:orders-cache';

function readCache() {
  try {
    const raw = wx.getStorageSync(CACHE_KEY);
    if (raw && Array.isArray(raw.orders)) return raw;
  } catch (e) {
    // 读取失败按无缓存处理。
  }
  return null;
}

function writeCache(orders) {
  try {
    wx.setStorageSync(CACHE_KEY, { savedAt: Date.now(), orders });
  } catch (e) {
    // 写缓存失败不影响展示。
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

  load() {
    if (this.loading) return;
    this.loading = true;

    const cached = readCache();
    const hasCache = !!cached;
    this.setData({
      // 有缓存时先展示缓存，不显示加载态；无缓存才显示 loading
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
      })
      .catch((error) => {
        if (hasCache) {
          // 有缓存兜底：不清空展示，只轻提示刷新失败。
          this.setData({ loading: false });
          wx.showToast({ title: '刷新失败，显示上次结果', icon: 'none', duration: 2000 });
        } else {
          this.setData({
            loading: false,
            failed: true,
            errorText: error && error.message ? error.message : '订单暂时无法获取，请稍后重试',
          });
        }
      })
      .then(() => {
        this.loading = false;
      });
  },

  onRetry() {
    if (!this.data.ordersReady) return;
    this.load();
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
