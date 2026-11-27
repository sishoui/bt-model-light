<!-- 横向柱状图：用于 Top N 维度（错误码、失败原因）。 -->
<script setup>
import { computed } from 'vue'

const props = defineProps({
  // [{ label, value, hint? }]
  items: { type: Array, default: () => [] },
  // 调色：默认从蓝到红渐变，让"最多的"最显眼
  color: { type: String, default: '#0088ff' },
  unit: { type: String, default: '' },
  emptyText: { type: String, default: '暂无数据' },
})

const max = computed(() => {
  let m = 0
  for (const it of props.items) m = Math.max(m, Number(it.value) || 0)
  return m || 1
})

function pct(v) {
  return Math.round(((Number(v) || 0) / max.value) * 100)
}
</script>

<template>
  <div class="bars">
    <div v-if="!items.length" class="bars__empty">{{ emptyText }}</div>
    <div v-for="(it, i) in items" :key="it.label + i" class="bars__row">
      <div class="bars__label" :title="it.label">{{ it.label || '（空）' }}</div>
      <div class="bars__track">
        <div class="bars__fill" :style="{ width: pct(it.value) + '%', background: color }"></div>
      </div>
      <div class="bars__value">
        {{ it.value }}{{ unit }}<span v-if="it.hint" class="bars__hint">{{ it.hint }}</span>
      </div>
    </div>
  </div>
</template>
