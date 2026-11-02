// 金额展示的唯一格式：千分位 + 两位小数（¥ 符号由界面自己放）。
// 全站金额都走这里，不再一处 3268.00、一处 48,210、一处 1,126.00。
// 展示串带逗号，不能再拿去算——要算的地方用 num() 还原，或者直接留原始数值。

/** 1234.5 → '1,234.50'；负数带前导 '-'；非数字当 0 */
function yuan(v) {
  const n = Number(v) || 0;
  const [int, dec] = Math.abs(n).toFixed(2).split('.');
  const neg = n < 0 && Number(Math.abs(n).toFixed(2)) > 0; // -0.001 不显示成 -0.00
  return (neg ? '-' : '') + int.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + dec;
}

/** 展示串还原成数值：'1,234.50' → 1234.5（容错：已是数值原样返回） */
function num(s) {
  return Number(String(s == null ? '' : s).replace(/,/g, '')) || 0;
}

module.exports = { yuan, num };
