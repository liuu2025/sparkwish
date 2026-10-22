const { STYLES, LENGTHS, getScene } = require('../../data/scenes');
const { generate } = require('../../utils/blessing');

function safeDecode(value) {
  try {
    return decodeURIComponent(value || '');
  } catch (e) {
    return value || '';
  }
}

function labelOf(list, id) {
  for (let i = 0; i < list.length; i += 1) {
    if (list[i].id === id) return list[i].name;
  }
  return '';
}

function isKnownId(list, id) {
  for (let i = 0; i < list.length; i += 1) {
    if (list[i].id === id) return true;
  }
  return false;
}

Page({
  data: {
    scene: null,
    summary: '',
    results: [],
    previousGroups: [],
  },

  onLoad(options) {
    const scene = getScene(safeDecode(options.scene));
    let style = safeDecode(options.style);
    let length = safeDecode(options.length);
    if (!isKnownId(STYLES, style)) style = 'warm';
    if (!isKnownId(LENGTHS, length)) length = 'medium';

    const role = safeDecode(options.role);
    let roleLabel = '';
    const relations = scene.relations || [];
    for (let i = 0; i < relations.length; i += 1) {
      if (relations[i].id === role) roleLabel = relations[i].label;
    }

    const summaryBits = [scene.name];
    if (roleLabel) summaryBits.push(roleLabel);
    summaryBits.push(labelOf(STYLES, style), labelOf(LENGTHS, length));

    this.setData({
      scene: {
        id: scene.id,
        name: scene.name,
        badge: scene.badge,
      },
      summary: summaryBits.join(' · '),
      params: {
        name: safeDecode(options.name),
        role,
        style,
        length,
      },
    }, () => {
      this.regenerate(false);
    });
  },

  regenerate(avoidPrevious) {
    const { scene, params } = this.data;
    if (!scene || !params) return;
    const fullScene = getScene(scene.id);
    const output = generate({
      scene: fullScene,
      name: params.name,
      role: params.role,
      style: params.style,
      length: params.length,
      avoidGroups: avoidPrevious ? this.data.previousGroups : [],
    });
    this.setData({
      results: output.results,
      previousGroups: output.groups,
    });
  },

  onRefresh() {
    if (this.refreshing) return;
    this.refreshing = true;
    this.regenerate(true);
    setTimeout(() => {
      this.refreshing = false;
    }, 300);
  },

  onCopy(e) {
    const index = Number(e.currentTarget.dataset.index);
    const item = this.data.results[index];
    if (!item) return;

    wx.setClipboardData({
      data: item.text,
      // 成功后由微信复制接口自带的“内容已复制”轻提示反馈，
      // 不再叠加自定义 toast，避免两个提示同时出现。
      fail: () => {
        wx.showToast({
          title: '复制失败，请长按选择文字',
          icon: 'none',
          duration: 1800,
        });
      },
    });
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

  onBackEdit() {
    wx.navigateBack({
      fail: () => {
        wx.reLaunch({ url: '/pages/home/index' });
      },
    });
  },
});
