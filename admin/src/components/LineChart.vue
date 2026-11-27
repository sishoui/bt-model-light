<!-- 折线图（多序列）。零依赖手写 SVG：后台只四页，不值得引 chart.js。 -->
<script setup>
import { computed } from 'vue'

const props = defineProps({
  // ['2026-11-01', ...]
  labels: { type: Array, required: true },
  // [{ name, color, values: [n, ...] }]
  series: { type: Array, default: () => [] },
  height: { type: Number, default: 180 },
  // 是否填充面积（单序列时好看；多序列会互相遮挡，默认只描线）
  area: { type: Boolean, default: false },
  // 是否显示图例
  legend: { type: Boolean, default: true },
})

const W = 720
const PAD = { top: 12, right: 8, bottom: 24, left: 36 }

const maxValue = computed(() => {
  let m = 0
  for (const s of props.series) for (const v of s.values || []) m = Math.max(m, Number(v) || 0)
  return m
})

// 「好看」的轴上限与步长：1/2/5 × 10^n，让 5 条刻度都落在整数上。
// 之前直接用 max 分段会产生 0/13/25/38/50 这种不能读的刻度。
const axis = computed(() => {
  const m = maxValue.value
  if (m <= 0) return { max: 4, step: 1 }
  const target = 4 // 希望 4 个间隔
  const raw = m / target
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  const norm = raw / mag
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10
  const step = Math.max(1, nice * mag)
  const max = Math.ceil(m / step) * step
  const count = max / step
  // 间隔太多时退一步（例如 100 会给出 4 段 25，够用）
  return { max, step, count }
})

const niceMax = computed(() => axis.value.max)

const plotW = computed(() => W - PAD.left - PAD.right)
const plotH = computed(() => props.height - PAD.top - PAD.bottom)

function x(i) {
  const n = Math.max(1, props.labels.length - 1)
  return PAD.left + (plotW.value * i) / n
}

function y(v) {
  const max = niceMax.value || 1
  return PAD.top + plotH.value * (1 - Math.min(1, (Number(v) || 0) / max))
}

function pathFor(values) {
  const pts = (values || []).map((v, i) => `${x(i)},${y(v)}`)
  if (!pts.length) return ''
  return 'M' + pts.join('L')
}

// 面积：线 + 底部闭合
function areaFor(values) {
  const p = pathFor(values)
  if (!p) return ''
  return `${p}L${x((values || []).length - 1)},${PAD.top + plotH.value}L${x(0)},${PAD.top + plotH.value}Z`
}

// 刻度：0..max 按 step 递增（整数、可读）。
const ticks = computed(() => {
  const { max, step } = axis.value
  const out = []
  for (let v = 0; v <= max + 1e-9; v += step) out.push({ v: Math.round(v), y: y(v) })
  return out
})

// X 轴标签抽稀：最多 7 个，避免挤在一起。
const labelStep = computed(() => Math.max(1, Math.ceil(props.labels.length / 7)))

// 'YYYY-MM-DD' → 'MM-DD'。切片而非 Date 解析：跨时区不会漂。
function shortDay(l) {
  const s = String(l || '')
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s.slice(5) : s
}

const hasData = computed(() =>
  props.series.some((s) => (s.values || []).some((v) => Number(v) > 0)),
)
// 全为 0 但序列存在（例如"还没有用户注册"）：不算"无数据"，
// 否则每条 0 值折线都盖一句提示，看起来像渲染失败。
const hasSeries = computed(() =>
  props.series.some((s) => (s.values || []).length > 0),
)
const showEmpty = computed(() => !hasData.value && !hasSeries.value)

</script>

<template>
  <div class="chart">
    <svg :viewBox="`0 0 ${W} ${height}`" preserveAspectRatio="none" class="chart__svg">
      <!-- 网格 + Y 刻度 -->
      <g>
        <line
          v-for="t in ticks"
          :key="'g' + t.v"
          :x1="PAD.left"
          :x2="W - PAD.right"
          :y1="t.y"
          :y2="t.y"
          class="chart__grid"
        />
        <text v-for="t in ticks" :key="'t' + t.v" :x="PAD.left - 6" :y="t.y + 3" class="chart__tick" text-anchor="end">
          {{ t.v }}
        </text>
      </g>

      <!-- 序列 -->
      <g v-for="(s, si) in series" :key="s.name">
        <path v-if="area && series.length === 1" :d="areaFor(s.values)" :fill="s.color || '#0088ff'" opacity="0.14" />
        <path
          :d="pathFor(s.values)"
          fill="none"
          :stroke="s.color || '#0088ff'"
          stroke-width="2"
          stroke-linejoin="round"
          stroke-linecap="round"
        />
        <!-- 数据点：序列少且短时显示，便于读数 -->
        <circle
          v-for="(v, i) in s.values"
          v-show="labels.length <= 16"
          :key="'p' + si + i"
          :cx="x(i)"
          :cy="y(v)"
          r="2.5"
          :fill="s.color || '#0088ff'"
        />
      </g>

      <!-- X 轴标签：首尾锚点外移，避免被视口裁切 -->
      <text
        v-for="(l, i) in labels"
        v-show="i % labelStep === 0 || i === labels.length - 1"
        :key="'x' + i"
        :x="i === 0 ? PAD.left : i === labels.length - 1 ? W - PAD.right : x(i)"
        :y="height - 6"
        class="chart__tick"
        :text-anchor="i === 0 ? 'start' : i === labels.length - 1 ? 'end' : 'middle'"
      >
        {{ shortDay(l) }}
      </text>

      <text v-if="showEmpty" :x="W / 2" :y="PAD.top + plotH / 2" class="chart__empty" text-anchor="middle">
        暂无数据
      </text>
    </svg>

    <div v-if="legend && series.length > 1" class="chart__legend">
      <span v-for="s in series" :key="s.name" class="chart__legend-item">
        <i class="chart__dot" :style="{ background: s.color || '#0088ff' }"></i>
        {{ s.name }}
      </span>
    </div>
  </div>
</template>
