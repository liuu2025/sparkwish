const TONE = {
  WAIT: 'wait',
  DELIVERING: 'delivering',
  DONE: 'done',
  CLOSED: 'closed',
  UNKNOWN: 'unknown',
};

function paymentStatusOf(order) {
  return String(
    order.payment_status ||
      (order.status === 'paid' ? 'paid' : order.status || '')
  ).toLowerCase();
}

function isPaid(order) {
  return !!order && paymentStatusOf(order) === 'paid';
}

function describe(order, options) {
  const opts = options || {};
  const checking = opts.checking === true;
  const paymentEnabled = opts.paymentEnabled === true;

  if (!order) {
    return {
      key: 'missing',
      title: '未找到此订单',
      hint: '请返回订单列表刷新后再试。',
      tone: TONE.UNKNOWN,
      canPay: false,
      canRefresh: true,
      showCard: false,
    };
  }

  const payment = paymentStatusOf(order);
  const delivery = String(order.delivery_status || '').toLowerCase();
  const showCard = !!order.card_code;

  if (payment === 'closed') {
    return {
      key: 'closed',
      title: '订单已关闭',
      hint: '如需购买，请回到商品页重新下单。',
      tone: TONE.CLOSED,
      canPay: false,
      canRefresh: true,
      showCard,
    };
  }

  if (payment === 'paid') {
    if (delivery === 'delivered') {
      return {
        key: 'delivered',
        title: '已交付',
        hint: '祝福语已确认，可复制使用。',
        tone: TONE.DONE,
        canPay: false,
        canRefresh: true,
        showCard,
      };
    }
    if (delivery === 'confirmation_pending') {
      return {
        key: 'delivered_confirming',
        title: '已交付',
        hint: '微信侧发货确认仍在处理，请稍后刷新。',
        tone: TONE.DONE,
        canPay: false,
        canRefresh: true,
        showCard,
      };
    }
    if (delivery === 'pending') {
      return {
        key: 'delivering',
        title: '已付款，正在交付',
        hint: '正在确认交付结果，请稍后刷新。',
        tone: TONE.DELIVERING,
        canPay: false,
        canRefresh: true,
        showCard,
      };
    }
    return {
      key: 'paid_unknown_delivery',
      title: '已付款，状态待确认',
      hint: '请刷新状态，以中枢返回的结果为准。',
      tone: TONE.UNKNOWN,
      canPay: false,
      canRefresh: true,
      showCard,
    };
  }

  if (payment === 'pending') {
    if (opts.verifyFailed === true) {
      return {
        key: 'verify_failed',
        title: '结果待确认',
        hint: '付款核实暂未完成，订单已保留，请稍后重试核实，请勿重复下单。',
        tone: TONE.WAIT,
        canPay: false,
        canRefresh: true,
        showCard,
      };
    }
    return {
      key: 'pending',
      title: '待付款',
      hint: checking ? '正在确认付款结果，请勿重复支付。' : '完成支付后，可在此刷新查看结果。',
      tone: TONE.WAIT,
      canPay: paymentEnabled,
      canRefresh: true,
      showCard,
    };
  }

  return {
    key: 'unknown',
    title: '状态待确认',
    hint: '订单结果以中枢核实为准，请勿重复下单。',
    tone: TONE.UNKNOWN,
    canPay: false,
    canRefresh: true,
    showCard,
  };
}

function formatAmount(cents) {
  const value = Number(cents);
  if (!isFinite(value) || value < 0) return '--';
  return (value / 100).toFixed(2);
}

function formatTime(seconds) {
  const value = Number(seconds);
  if (!isFinite(value) || value <= 0) return '--';
  const date = new Date(value * 1000);
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  return (
    date.getFullYear() +
    '-' +
    pad(date.getMonth() + 1) +
    '-' +
    pad(date.getDate()) +
    ' ' +
    pad(date.getHours()) +
    ':' +
    pad(date.getMinutes())
  );
}

function maskCard(code) {
  const value = String(code || '');
  if (!value) return '';
  if (value.length <= 4) return value.slice(0, 1) + '****';
  return value.slice(0, 3) + '****';
}

module.exports = {
  describe,
  isPaid,
  formatAmount,
  formatTime,
  maskCard,
};
