const shop = require('./shop');
const perf = require('./perf');

// 内存中的当前购买核实流程。仅存在于页面栈生命周期内，
// 不写入本地缓存、URL 或日志，也不包含任何凭据或交付内容。
let flow = null;

function begin(queryCode, order) {
  flow = {
    orderID: (order && order.id) || '',
    queryCode,
    snapshot: order || null,
    savedAt: Date.now(),
    // 全购买流程唯一一次 orders/sync 核实，由 begin 发起。
    syncPromise: shop.syncOrder(queryCode),
  };
  perf.mark('sync_start');
  return flow.syncPromise;
}

// 订单详情页命中后：先展示快照，再等待同一次核实结果。
function get(orderID) {
  if (!flow || !orderID || flow.orderID !== orderID) return null;
  if (Date.now() - flow.savedAt > 5 * 60 * 1000) return null;
  return flow;
}

function clear() {
  flow = null;
}

module.exports = {
  begin,
  get,
  clear,
};
