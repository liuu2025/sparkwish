const config = require('../../../config/shop');
const shop = require('../../../utils/shop');
const pay = require('../../../utils/pay');
const verify = require('../../../utils/verify');
const perf = require('../../../utils/perf');
const { describe, formatAmount, formatTime } = require('../../../utils/order-state');
const { PREMIUM_BLESSINGS } = require('../../../data/premium');

const POLL_BASE_MS = 3000;
const POLL_MAX_MS = 10000;
const POLL_MAX_TIMES = 12;
const POLL_MAX_WINDOW_MS = 90 * 1000;

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

function randomBlessing(avoid) {
  const pool = PREMIUM_BLESSINGS.filter((item) => item && avoid.indexOf(item) < 0);
  const source = pool.length ? pool : PREMIUM_BLESSINGS;
  return source[Math.floor(Math.random() * source.length)] || '';
}

// 需要持续关注的状态：未支付、未交付、核实失败或状态未知。
function needsWatching(state) {
  const key = state && state.key;
  return (
    key === 'pending' ||
    key === 'delivering' ||
    key === 'paid_unknown_delivery' ||
    key === 'verify_failed' ||
    key === 'unknown'
  );
}

function isFinal(state) {
  const key = state && state.key;
  return key === 'delivered' || key === 'closed';
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
    verifying: false,
    stageText: '',
  },

  onLoad(options) {
    let id = '';
    try {
      id = decodeURIComponent(options.id || '');
    } catch (e) {
      id = options.id || '';
    }
    this.orderID = id;
    this.lastOrder = null;
    this.pollTimes = 0;
    this.pollGeneration = 0;
    this.watching = false;
    const ready = shop.ordersReady();
    this.setData({ ordersReady: ready });
    if (!ready) return;

    // 购买流程刚结束：先展示中枢返回的当前订单快照，再等待同一次核实结果。
    const flow = verify.get(id);
    if (flow && flow.snapshot) {
      this.applyOrder(flow.snapshot, { checking: true });
      this.awaitVerify(flow);
      return;
    }
    // 重新进入或无内存结果：保留原有恢复路径。
    this.load();
  },

  // 等待 verify.begin 发起的那一次核实；不重复发起 sync。
  awaitVerify(flow) {
    this.setData({ verifying: true, stageText: '正在核实付款…' });
    flow.syncPromise
      .then((res) => {
        perf.mark('sync_done');
        // 轮询若已先行确认终态，迟到的核实结果不得回退页面状态。
        if (!isFinal(this.data.state)) {
          const next = pickOrder(res);
          if (next) {
            this.applyOrder(next);
          } else {
            this.applyOrder(flow.snapshot, { verifyFailed: true });
          }
        }
        verify.clear();
      })
      .catch(() => {
        perf.mark('sync_done');
        if (!isFinal(this.data.state)) {
          // 核实失败：订单保留，展示“结果待确认”，可手动重试核实。
          this.applyOrder(flow.snapshot, { verifyFailed: true });
        }
        verify.clear();
      })
      .then(() => {
        this.setData({ verifying: false, stageText: '' });
      });
  },

  onRetryVerify() {
    if (this.data.verifying) return;
    if (!this.queryCode) {
      this.load();
      return;
    }
    this.setData({ verifying: true, stageText: '正在核实付款…' });
    shop
      .syncOrder(this.queryCode)
      .then((res) => {
        const next = pickOrder(res);
        if (next) this.applyOrder(next);
      })
      .catch((error) => {
        wx.showToast({
          title: (error && error.message) || '结果待确认，请稍后重试',
          icon: 'none',
          duration: 2000,
        });
      })
      .then(() => {
        this.setData({ verifying: false, stageText: '' });
      });
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
    this.startWatching();
  },

  onHide() {
    this.stopWatching();
  },

  onUnload() {
    this.stopWatching();
  },

  // 有界的状态关注：仅页面可见且状态未完成时，用只读查询短时轮询。
  // 不轮询核实接口；核实由购买流程的那一次 sync 和手动重试承担。
  startWatching() {
    this.stopWatching();
    if (!this.data.ordersReady || !this.orderID || !this.queryCode) return;
    const state = this.data.state;
    if (!state || isFinal(state) || !needsWatching(state)) return;

    this.pollGeneration += 1;
    const generation = this.pollGeneration;
    this.pollTimes = 0;
    this.watchStartedAt = Date.now();
    this.watching = true;

    const tick = () => {
      if (generation !== this.pollGeneration) return;
      if (this.pollTimes >= POLL_MAX_TIMES) {
        this.stopWatching();
        return;
      }
      this.pollTimes += 1;
      shop
        .queryOrder(this.queryCode)
        .then((res) => {
          if (generation !== this.pollGeneration) return; // 丢弃迟到响应
          const next = pickOrder(res);
          if (next) this.applyOrder(next);
        })
        .catch(() => {
          // 只读查询失败不打断关注，由下一次退避后的查询补上。
        })
        .then(() => {
          if (generation !== this.pollGeneration) return;
          const delay = Math.min(
            POLL_BASE_MS * Math.pow(1.5, this.pollTimes - 1),
            POLL_MAX_MS
          );
          if (Date.now() - this.watchStartedAt + delay > POLL_MAX_WINDOW_MS) {
            this.stopWatching();
            return;
          }
          this.pollTimer = setTimeout(tick, delay);
        });
    };

    this.pollTimer = setTimeout(tick, POLL_BASE_MS);
  },

  stopWatching() {
    this.pollGeneration += 1;
    this.watching = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  },

  applyOrder(found, options) {
    const opts = options || {};
    if (!found) {
      this.lastOrder = null;
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
      this.stopWatching();
      return;
    }
    this.lastOrder = found;
    if (found.query_code) this.queryCode = found.query_code;
    const state = describe(found, {
      paymentEnabled: config.paymentEnabled === true,
      checking: opts.checking === true,
      verifyFailed: opts.verifyFailed === true,
    });
    const pending = state.key === 'pending';
    const cardCode = state.showCard ? found.card_code || '' : '';
    let blessing = this.blessingText || '';
    if (!blessing && cardCode) {
      blessing = randomBlessing([this.blessingText]);
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
    if (isFinal(state)) {
      // 订单进入终态后，内存中的核实流程与关注循环都不再需要。
      verify.clear();
      this.stopWatching();
    } else if (needsWatching(state) && !this.watching) {
      this.startWatching();
    }
  },

  onRefresh() {
    if (!this.data.ordersReady) return;
    if (!this.queryCode) {
      this.load();
      return;
    }
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
    this.setData({ verifying: true });

    // 阶段一：准备支付（获取支付参数）。
    let stage = 'params';
    this.setData({ stageText: '正在准备支付…' });
    const finish = () => {
      this.paying = false;
      this.setData({ verifying: false, stageText: '' });
    };
    pay
      .fetchPayParams(this.queryCode)
      .then((virtualPayment) => {
        // 阶段二：微信收银台（原生 UI）。
        stage = 'pay';
        perf.mark('pay_invoke');
        return pay.requestPayment(virtualPayment);
      })
      .then(() => {
        // 阶段三：正在核实付款（受控核实，结果以中枢为准）。
        stage = 'sync';
        perf.mark('pay_callback');
        this.setData({ stageText: '正在核实付款…' });
        return shop.syncOrder(this.queryCode);
      })
      .then((res) => {
        perf.mark('sync_done');
        if (!isFinal(this.data.state)) {
          const next = pickOrder(res);
          if (next) this.applyOrder(next);
        }
        finish();
      })
      .catch((error) => {
        if (stage === 'sync') perf.mark('sync_done');
        if (stage === 'params') {
          // 取参失败：支付尚未发起，订单保持待付款。
          wx.showToast({
            title: (error && error.message) || '支付暂不可用，请稍后重试',
            icon: 'none',
            duration: 2200,
          });
          if (this.lastOrder) this.applyOrder(this.lastOrder);
          else this.load();
        } else if (stage === 'pay' && error && error.code === 'cancelled') {
          // 用户取消：支付未完成，订单保持待付款。
          wx.showToast({ title: '已取消支付', icon: 'none', duration: 2200 });
          if (this.lastOrder) this.applyOrder(this.lastOrder);
          else this.load();
        } else {
          // 支付结果未知或核实未完成：不判定失败，保留订单与重试核实入口。
          wx.showToast({
            title: '结果待确认，请勿重复下单',
            icon: 'none',
            duration: 2200,
          });
          if (this.lastOrder) this.applyOrder(this.lastOrder, { verifyFailed: true });
          else this.load();
        }
        finish();
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
