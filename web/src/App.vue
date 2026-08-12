<script setup>
// 根组件：双栏布局（主栏上传面板 / 侧栏草稿管理），窄屏自动堆叠
import UploadPanel from './components/UploadPanel.vue'
import DraftPanel from './components/DraftPanel.vue'
</script>

<template>
  <div class="wrap">
    <div class="cols">
      <main class="col-main">
        <UploadPanel />
      </main>
      <aside class="col-side">
        <DraftPanel />
      </aside>
    </div>
  </div>
</template>
