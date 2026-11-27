// 悬浮 Dock（design.md §7.0）。自定义 tabBar 组件：
// 选中态由各 Tab 页 onShow 时 getTabBar().setData({ selected }) 同步。
// 中央 FAB = 新增设备（进设备列表页扫描），与「设备」Tab 并列但视觉上抬高。
Component({
  data: {
    selected: 0,
  },

  methods: {
    onSwitchTab(e) {
      const index = Number(e.currentTarget.dataset.index)
      if (index === this.data.selected) return
      wx.switchTab({
        url: index === 0 ? '/pages/home/home' : '/pages/profile/profile',
      })
    },

    onAddDevice() {
      wx.navigateTo({ url: '/pages/device-list/device-list' })
    },
  },
})
