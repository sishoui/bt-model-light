<!-- 直方图：分桶分布（BLE MTU、RSSI）。桶已由后端算好，这里只画。 -->
<script setup>
import { computed } from 'vue'

const props = defineProps({
  // [{ from, to, count }]
  buckets: { type: Array, default: () => [] },
  color: { type: String, default: '#0088ff' },
  height: { type: Number, default: 120 },
  // 桶标签格式化：默认取整后连接
  labelFormat: { type: Function, default: null },
  highlight: { type: Function, default: null }, // (bucket) => boolean，标红某几桶
  emptyText: { type: String, default: '暂无数据' },
})

const max = computed(() => {
  let m = 0
  for (const b of props.buckets) m = Math.max(m, Number(b.count) || 0)
  return m || 1
})

function label(b) {
  if (props.labelFormat) return props.labelFormat(b)
  return `${Math.round(b.from)}–${Math.round(b.to)}`
}

// 桶多时标签抽稀：容器宽度有限，8 个桶写 8 个区间必然重叠。
// 只给偶数下标（以及最后一个）出标签，读图靠柱高与悬浮 title。
const labelEvery = computed(() => (props.buckets.length > 6 ? 2 : 1))

const hasData = computed(() => props.buckets.some((b) => Number(b.count) > 0))
</script>

<template>
  <div class="histo">
    <div class="histo__bars" :style="{ height: height + 'px' }">
      <div v-for="(b, i) in buckets" :key="i" class="histo__col" :title="`${label(b)} · ${b.count}`">
        <div class="histo__count">{{ b.count || '' }}</div>
        <div class="histo__bar-wrap">
          <div
            class="histo__bar"
            :style="{
              height: Math.round(((Number(b.count) || 0) / max) * 100) + '%',
              background: highlight && highlight(b) ? 'var(--danger)' : color,
            }"
          ></div>
        </div>
        <div class="histo__label">
          {{ i % labelEvery === 0 || i === buckets.length - 1 ? label(b) : '' }}
        </div>
      </div>
    </div>
    <div v-if="!hasData" class="bars__empty">{{ emptyText }}</div>
  </div>
</template>
