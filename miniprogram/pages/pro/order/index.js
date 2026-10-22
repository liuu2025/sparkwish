const config = require('../../../config/shop');
const shop = require('../../../utils/shop');
const pay = require('../../../utils/pay');
const { describe, formatAmount, formatTime } = require('../../../utils/order-state');
const { SCENES, STYLES, LENGTHS } = require('../../../data/scenes');
const blessingGen = require('../../../utils/blessing');

// 中枢的 query/sync 返回订单本身；兼容外层再包一层 order 的情况。
function pickOrder(res) {
  if (!res) return null;
  if (res.order) return res.order;
  if (res.id) return res;
  return null;
}

function toOrderView(order) {
  const snapshot = order.snapshot || {};
  return {
    id: order.id,
    name: snapshot.name || '套餐',
    price: formatAmount(order.price_cents),
    createdText: formatTime(order.created_at),
    paidText: order.paid_at ? formatTime(order.paid_at) : '',
  };
}

// 本地随机组合一段祝福语，随卡密一起提供给用户复制。
function randomBlessing() {
  const scene = SCENES[Math.floor(Math.random() * SCENES.length)];
  const styleItem = STYLES[Math.floor(Math.random() * STYLES.length)];
  const lengthItem = LENGTHS[Math.floor(Math.random() * LENGTHS.length)];
  const generated = blessingGen.generate({
    scene,
    style: styleItem ? styleItem.id : 'warm',
    length: lengthItem ? lengthItem.id : 'medium',
    role: '',
    name: '',
  });
  const results = (generated && generated.results) || [];
  if (!results.length) return '';
  const pick = results[Math.floor(Math.random() * results.length)];
  return (pick && pick.text) || '';
}

Page({
  data: {
    ordersReady: false,
    loading: false,
    failed: false,
    errorText: '',
    order: null,
    state: null,
    showPay: false,
    blessing: '',
    cardCode: '',
    payHint: '',
  },

  onLoad(options) {
    let id = '';
    try {
      id = decodeURIComponent(options.id || '');
    } catch (e) {
      id = options.id || '';
    }
    this.orderID = id;
    const ready = shop.ordersReady();
    this.setData({ ordersReady: ready });
    if (!ready) return;
    this.load();
  },

  load() {
    if (this.loading) return;
    this.loading = true;
    this.setData({ loading: true, failed: false, errorText: '' });
    shop
      .fetchOrders()
      .then((list) => {
        const found = (list || []).find((item) => item.id === this.orderID);
        this.applyOrder(found);
        this.setData({ loading: false });
      })
      .catch((error) => {
        this.setData({
          loading: false,
          failed: true,
          errorText: error && error.message ? error.message : '订单暂时无法获取，请稍后重试',
        });
      })
      .then(() => {
        this.loading = false;
      });
  },

  onShow() {
    if (!this.data.ordersReady || !this.orderID || !this.queryCode) return;
    // 轻量刷新：只读取订单，不触发中枢核对。
    shop
      .queryOrder(this.queryCode)
      .then((res) => {
        const next = pickOrder(res);
        if (next) this.applyOrder(next);
      })
      .catch(() => {
        // 自动刷新失败不改变页面结论。
      });
  },

  applyOrder(found) {
    if (!found) {
      this.blessingText = '';
      this.setData({
        order: null,
        state: describe(null),
        showPay: false,
        blessing: '',
        cardCode: '',
        copyText: '',
        payHint: '',
      });
      return;
    }
    // 私密查询号只留在内存，不渲染、不写缓存、不拼进页面路径。
    if (found.query_code) this.queryCode = found.query_code;
    const state = describe(found, { paymentEnabled: config.paymentEnabled === true });
    const pending = state.key === 'pending';
    // 高级祝福语展示位：本地随机组合一段祝福语，随卡密一起提供。
    // 订单恢复只恢复订单与卡密，不宣称恢复原文。
    const cardCode = state.showCard ? found.card_code || '' : '';
    let blessing = this.blessingText || '';
    if (!blessing && cardCode) {
      blessing = randomBlessing();
      this.blessingText = blessing;
    }
    const copyText = [blessing, cardCode].filter(Boolean).join('\n\n');
    this.setData({
      order: toOrderView(found),
      state,
      showPay: pending,
      blessing,
      cardCode,
      copyText,
      payHint: pending && config.paymentEnabled !== true ? '支付功能暂未开放。' : '',
    });
  },

  onRefresh() {
    if (!this.data.ordersReady) return;
    if (!this.queryCode) {
      this.load();
      return;
    }
    // 请中枢核对支付；结果未知时保留当前展示，不判定订单失败，也不重新下单。
    wx.showLoading({ title: '正在核对', mask: true });
    shop
      .syncOrder(this.queryCode)
      .then((res) => {
        wx.hideLoading();
        const next = pickOrder(res);
        if (next) this.applyOrder(next);
        else this.load();
      })
      .catch((error) => {
        wx.hideLoading();
        wx.showToast({
          title: (error && error.message) || '结果待确认，请稍后重试',
          icon: 'none',
          duration: 2000,
        });
      });
  },

  onPay() {
    if (!this.data.state || !this.data.state.canPay) {
      wx.showToast({ title: '当前无法支付', icon: 'none' });
      return;
    }
    if (!this.queryCode) {
      wx.showToast({ title: '支付信息暂不可用，请刷新后重试', icon: 'none' });
      return;
    }
    if (this.paying) return;
    this.paying = true;
    wx.showLoading({ title: '正在发起支付', mask: true });
    pay
      .payForOrder(this.queryCode)
      .then(() => shop.syncOrder(this.queryCode).catch(() => {}))
      .then(() => {
        wx.hideLoading();
        this.load();
      })
      .catch((error) => {
        wx.hideLoading();
        wx.showToast({
          title: (error && error.message) || '支付未完成',
          icon: 'none',
          duration: 2200,
        });
      })
      .then(() => {
        this.paying = false;
      });
  },

  onCopyBlessing() {
    const text = this.data.copyText;
    if (!text) {
      wx.showToast({ title: '暂无可复制的祝福语', icon: 'none' });
      return;
    }
    wx.setClipboardData({
      data: text,
      fail: () => {
        wx.showToast({ title: '复制失败，请长按选择文字', icon: 'none', duration: 1800 });
      },
    });
  },

  onBackList() {
    wx.navigateBack({
      fail: () => {
        wx.redirectTo({ url: '/pages/pro/orders/index' });
      },
    });
  },
});
