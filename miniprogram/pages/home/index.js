const { SCENES } = require('../../data/scenes');

// 从微信运行时读取版本号，随发布版本自动同步；开发/体验环境回退显示环境名。
function getVersion() {
  try {
    const info = wx.getAccountInfoSync();
    const mp = info && info.miniProgram;
    const v = mp && mp.version;
    if (v) return 'v' + v;
    if (mp && mp.envVersion === 'trial') return '体验版';
    if (mp && mp.envVersion === 'develop') return '开发版';
  } catch (e) {
    // 读取失败则不显示版本号。
  }
  return '';
}

Page({
  data: {
    version: '',
    scenes: SCENES.map((item) => ({
      id: item.id,
      name: item.name,
      desc: item.desc,
    })),
  },

  onLoad() {
    this.setData({ version: getVersion() });
  },

  onOpenPro() {
    const now = Date.now();
    if (now - (this.lastProTap || 0) < 400) return;
    this.lastProTap = now;

    wx.navigateTo({
      url: '/pages/pro/index',
      fail: () => {
        wx.showToast({ title: '页面打开失败，请重试', icon: 'none' });
      },
    });
  },

  onSelectScene(e) {
    const now = Date.now();
    if (now - (this.lastTap || 0) < 400) return;
    this.lastTap = now;

    const id = e.currentTarget.dataset.id;
    wx.navigateTo({
      url: '/pages/create/index?scene=' + encodeURIComponent(id),
      fail: () => {
        wx.showToast({ title: '页面打开失败，请重试', icon: 'none' });
      },
    });
  },
});
