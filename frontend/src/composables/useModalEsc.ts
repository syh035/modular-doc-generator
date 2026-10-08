import { onBeforeUnmount, onMounted, onUpdated, useTemplateRef } from 'vue'

// 原生 dialog 进入顶层并隔离背景；栈确保叠加弹层只有最上层处理键盘。
const modalStack: HTMLDialogElement[] = []
const focusableSelector =
  'button, input, select, textarea, a[href], [tabindex], [contenteditable="true"]'

export function useModalEsc(onClose: () => void) {
  const modal = useTemplateRef<HTMLDialogElement>('modal')
  let opener: HTMLElement | null = null
  let dialog: HTMLDialogElement | null = null

  function isTop(): boolean {
    return dialog !== null && modalStack.at(-1) === dialog
  }

  function focusable(): HTMLElement[] {
    if (!dialog) return []
    return [...dialog.querySelectorAll<HTMLElement>(focusableSelector)].filter(element => {
      if (element.tabIndex < 0 || element.matches(':disabled') || element.closest('[hidden], [inert]')) {
        return false
      }
      for (let parent: HTMLElement | null = element; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent)
        if (style.display === 'none' || style.visibility === 'hidden') return false
        if (parent === dialog) break
      }
      return true
    })
  }

  function focusFirst(): void {
    const elements = focusable()
    const target = elements.find(element => element.hasAttribute('data-modal-autofocus'))
      ?? elements[0] ?? dialog
    target?.focus({ preventScroll: true })
  }

  function keepFocus(): void {
    if (!isTop()) return
    const active = document.activeElement
    if (!active || !dialog?.contains(active) || active.matches(':disabled')) focusFirst()
  }

  function onKeydown(event: KeyboardEvent): void {
    if (!isTop() || event.isComposing) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopImmediatePropagation()
      onClose()
    } else if (event.key === 'Tab') {
      const elements = focusable()
      const first = elements[0]
      const last = elements.at(-1)
      const active = document.activeElement
      if (!first || !last) {
        event.preventDefault()
        dialog?.focus()
      } else if (!dialog?.contains(active) || (event.shiftKey ? active === first : active === last)) {
        event.preventDefault()
        ;(event.shiftKey ? last : first).focus()
      }
    }
  }

  function onCancel(event: Event): void {
    // Esc/平台取消统一交给组件事件，避免原生关闭后 Vue 状态仍显示弹层。
    event.preventDefault()
    if (isTop()) onClose()
  }

  onMounted(() => {
    dialog = modal.value
    // 脱离文档的组件测试不占用全局焦点，也不污染后续测试的监听器。
    if (!dialog?.isConnected) return
    opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    modalStack.push(dialog)
    document.addEventListener('keydown', onKeydown, true)
    document.addEventListener('focusin', keepFocus)
    dialog.addEventListener('cancel', onCancel)
    if (typeof dialog.showModal === 'function') dialog.showModal()
    else dialog.setAttribute('open', '') // jsdom 未实现 dialog API。
    focusFirst()
  })

  // 如迁移 prompt→plan 换掉当前按钮，焦点留在新的弹层内容中。
  onUpdated(keepFocus)

  onBeforeUnmount(() => {
    const wasTop = isTop()
    const index = dialog ? modalStack.indexOf(dialog) : -1
    if (index >= 0) modalStack.splice(index, 1)
    document.removeEventListener('keydown', onKeydown, true)
    document.removeEventListener('focusin', keepFocus)
    dialog?.removeEventListener('cancel', onCancel)
    if (dialog?.open && typeof dialog.close === 'function') dialog.close()
    if (wasTop && opener?.isConnected && !opener.closest('[inert]')) {
      opener.focus({ preventScroll: true })
    }
  })

  return modal
}
