const { SCENES } = require('../../data/scenes');

Page({
  data: {
    version: '1.0.0',
    scenes: SCENES.map((item) => ({
      id: item.id,
      name: item.name,
      desc: item.desc,
    })),
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
