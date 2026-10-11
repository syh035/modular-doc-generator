import { describe, expect, it } from 'vitest'
import { formatOverflowGrowth } from './overflow'
describe('溢出增高显示精度', () => {
  it.each([[0.25, '+25%'], [0.5, '+50%'], [0.002, '+0.2%'], [0.0002, '不足 0.1%']])(
    'ratio %s 显示为 %s', (ratio, expected) => expect(formatOverflowGrowth(ratio as number)).toBe(expected),
  )
})
