<!-- 环形图：占比类（固件版本分布、真实/模拟设备）。 -->
<script setup>
import { computed } from 'vue'

const props = defineProps({
  // [{ label, value, color? }]
  items: { type: Array, default: () => [] },
  size: { type: Number, default: 132 },
  thickness: { type: Number, default: 18 },
  centerLabel: { type: String, default: '' },
})

const PALETTE = ['#0088ff', '#34c759', '#ff8d28', '#af52de', '#ff383c', '#5ac8fa', '#ffcc00', '#8e8e93']

const total = computed(() => props.items.reduce((s, it) => s + (Number(it.value) || 0), 0))

const segments = computed(() => {
  const t = total.value || 1
  const r = (props.size - props.thickness) / 2
  const c = props.size / 2
  let acc = 0
  return props.items.map((it, i) => {
    const frac = (Number(it.value) || 0) / t
    const start = acc * 2 * Math.PI - Math.PI / 2
    acc += frac
    const end = acc * 2 * Math.PI - Math.PI / 2
    // 单一段占满：直接画整圆（避免 0 与 2π 重合时 arc 退化）
    const full = frac >= 0.9999
    const x1 = c + r * Math.cos(start)
    const y1 = c + r * Math.sin(start)
    const x2 = c + r * Math.cos(end)
    const y2 = c + r * Math.sin(end)
    const color = it.color || PALETTE[i % PALETTE.length]
    return {
      color,
      label: it.label,
      value: it.value,
      pct: Math.round(frac * 100),
      full,
      r,
      c,
      x1,
      y1,
      x2,
      y2,
      sweep: frac > 0.5 - 1e-9 ? 1 : 0,
    }
  })
})
</script>

<template>
  <div class="donut">
    <svg :width="size" :height="size" :viewBox="`0 0 ${size} ${size}`">
      <circle
        v-if="!total"
        :cx="size / 2"
        :cy="size / 2"
        :r="(size - thickness) / 2"
        fill="none"
        stroke="var(--separator)"
        :stroke-width="thickness"
      />
      <template v-for="(s, i) in segments" :key="i">
        <circle
          v-if="s.full"
          :cx="s.c"
          :cy="s.c"
          :r="s.r"
          fill="none"
          :stroke="s.color"
          :stroke-width="thickness"
        />
        <path
          v-else-if="s.value > 0"
          :d="`M${s.x1},${s.y1}A${s.r},${s.r} 0 ${s.sweep} 1 ${s.x2},${s.y2}`"
          fill="none"
          :stroke="s.color"
          :stroke-width="thickness"
          stroke-linecap="butt"
        />
      </template>
      <text v-if="centerLabel" :x="size / 2" :y="size / 2 + 4" text-anchor="middle" class="donut__center">
        {{ centerLabel }}
      </text>
    </svg>

    <div class="donut__legend">
      <div v-if="!items.length" class="bars__empty">暂无数据</div>
      <div v-for="(s, i) in segments" :key="'l' + i" class="donut__item">
        <i class="chart__dot" :style="{ background: s.color }"></i>
        <span class="donut__label">{{ s.label || '（空）' }}</span>
        <span class="donut__value">{{ s.value }}</span>
        <span class="donut__pct">{{ s.pct }}%</span>
      </div>
    </div>
  </div>
</template>
