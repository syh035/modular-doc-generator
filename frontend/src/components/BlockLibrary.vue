<template>
  <!-- 左栏：字符块库（M2 实现，M0 占位） -->
  <aside class="block-library">
    <div class="header">
      <span>字符块库</span>
      <button disabled>
        + 新建字符块
      </button>
    </div>
    <div class="placeholder">
      块库（M2 实现）
    </div>
  </aside>
</template>

<style scoped>
.block-library {
  width: 320px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: #fff;
  border-right: 1px solid #e2e3e5;
}

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid #e2e3e5;
}

.placeholder {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #8f959e;
}
</style>
