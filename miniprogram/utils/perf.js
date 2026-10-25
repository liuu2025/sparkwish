const TRUTHY_ENV = { develop: true, trial: true };

function enabled() {
  try {
    const info = wx.getAccountInfoSync();
    const mp = info && info.miniProgram;
    return !!(mp && TRUTHY_ENV[mp.envVersion]);
  } catch (e) {
    return false;
  }
}

const on = enabled();

function networkType(done) {
  if (!on || typeof wx.getNetworkType !== 'function') {
    if (typeof done === 'function') done('');
    return;
  }
  wx.getNetworkType({
    success(res) {
      if (typeof done === 'function') done((res && res.networkType) || '');
    },
    fail() {
      if (typeof done === 'function') done('');
    },
  });
}

function mark(name, extra) {
  if (!on) return;
  const entry = { t: Date.now(), name };
  if (extra) entry.extra = extra;
  networkType(function (type) {
    if (type) entry.net = type;
    try {
      console.log('[perf]', entry.name, 'net=' + (entry.net || '?'), 't=' + entry.t, entry.extra || '');
    } catch (e) {
    }
  });
}

module.exports = {
  mark,
  enabled: function () {
    return on;
  },
};
