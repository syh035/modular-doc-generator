/** 小幅真实增高保留小数，不能显示为 +0%；裁剪提示由调用方处理。 */
export function formatOverflowGrowth(ratio: number): string {
  const percent = ratio * 100
  if (percent > 0 && percent < 0.1) return '不足 0.1%'
  if (percent > 0 && percent < 1) return `+${percent.toFixed(1)}%`
  return `+${Math.round(percent)}%`
}
