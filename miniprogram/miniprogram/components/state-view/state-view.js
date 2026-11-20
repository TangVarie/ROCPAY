// 状态页：加载 / 出错 / 空 / 无权限，两个页面共 14 处，版式统一成一套。
// 加载：山形弧带 + 两行字；其余（出错/空/无权限）：浅青说明块——一行标题 + 一行说明（+ 可选的错误细节）+ 可选的一个次按钮，不放图标（v6.3）。
// 按钮只往外抛 action 事件，具体做什么（重试、清除筛选）由页面决定。
// styleIsolation: apply-shared —— 山形加载 .band-spinner（kit）、按钮 .btn 都在 app.wxss
Component({
  properties: {
    icon: { type: String, value: 'alert' }, // spinner（加载中）| 其它取值（alert | inbox | users | gift）一律渲染成说明块；保留取值以示语义
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
