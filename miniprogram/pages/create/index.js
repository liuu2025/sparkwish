const { STYLES, LENGTHS, getScene } = require('../../data/scenes');

Page({
  data: {
    scene: null,
    relations: [],
    placeholder: '例如：妈妈、老王、小满',
    name: '',
    role: '',
    styles: STYLES,
    lengths: LENGTHS,
    style: 'warm',
    length: 'medium',
  },

  onLoad(options) {
    let sceneId = '';
    try {
      sceneId = decodeURIComponent(options.scene || '');
    } catch (e) {
      sceneId = options.scene || '';
    }
    const scene = getScene(sceneId);
    this.setData({
      scene: {
        id: scene.id,
        name: scene.name,
        badge: scene.badge,
        desc: scene.desc,
      },
      relations: scene.relations || [],
      placeholder: scene.placeholder || '例如：妈妈、老王、小满',
    });
  },

  onNameInput(e) {
    this.setData({ name: e.detail.value });
  },

  onRoleTap(e) {
    const id = e.currentTarget.dataset.id;
    this.setData({ role: this.data.role === id ? '' : id });
  },

  onStyleTap(e) {
    this.setData({ style: e.currentTarget.dataset.id });
  },

  onLengthTap(e) {
    this.setData({ length: e.currentTarget.dataset.id });
  },

  onGenerate() {
    if (this.generating || !this.data.scene) return;
    this.generating = true;

    const scene = this.data.scene;
    const query = [
      'scene=' + encodeURIComponent(scene.id),
      'name=' + encodeURIComponent(this.data.name || ''),
      'role=' + encodeURIComponent(this.data.role || ''),
      'style=' + encodeURIComponent(this.data.style),
      'length=' + encodeURIComponent(this.data.length),
    ].join('&');

    wx.navigateTo({
      url: '/pages/result/index?' + query,
      complete: () => {
        setTimeout(() => {
          this.generating = false;
        }, 400);
      },
    });
  },
});
