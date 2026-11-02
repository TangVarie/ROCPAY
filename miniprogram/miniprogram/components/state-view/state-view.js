// 状态页：加载 / 出错 / 空 / 无权限，两个页面共 14 处，版式统一成一套。
// 图标 + 一行标题 + 一行说明（+ 可选的错误细节）+ 可选的一个次按钮。
// 按钮只往外抛 action 事件，具体做什么（重试、清除筛选）由页面决定。
// styleIsolation: apply-shared —— 线性图标 .li-*、山形加载 .band-spinner、按钮 .btn 都在 app.wxss
Component({
  properties: {
    icon: { type: String, value: 'alert' }, // spinner（加载中） | alert | inbox | users | gift（对应 app.wxss 的 .li-*）
    title: { type: String, value: '' },
    desc: { type: String, value: '' },
    detail: { type: String, value: '' }, // 错误细节（接口报错原文），小字、最多几行
    btnText: { type: String, value: '' }, // 空 = 不出按钮
  },
  methods: {
    onAction() {
      this.triggerEvent('action');
    },
  },
});
