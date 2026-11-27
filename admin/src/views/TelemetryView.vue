<!-- 遥测：任选指标看时序 + Top 维度分布（ADR-0037）。
     指标字典来自后端 /telemetry/metrics，前端不硬编码。 -->
<script setup>
import { computed, onMounted, ref } from 'vue'
import { admin } from '../api.js'
import LineChart from '../components/LineChart.vue'
import BarList from '../components/BarList.vue'

const COLORS = ['#0088ff', '#34c759', '#af52de', '#ff8d28', '#ff383c', '#5ac8fa', '#ffcc00']
const DEFAULT_METRICS = ['app.launch', 'ble.connect.ok', 'config.write']

const days = ref(14)
const dict = ref([])
const selected = ref(DEFAULT_METRICS.slice())
const data = ref(null)
const error = ref('')
const loading = ref(false)

async function loadDict() {
  try {
    const r = await admin.metrics()
    dict.value = r.items || []
  } catch (_e) {
    dict.value = []
  }
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    data.value = await admin.telemetry({ days: days.value, metrics: selected.value.join(',') })
  } catch (err) {
    error.value = err.message || String(err)
  } finally {
    loading.value = false
  }
}

function toggle(metric) {
  const i = selected.value.indexOf(metric)
  if (i >= 0) {
    if (selected.value.length === 1) return // 至少留一条
    selected.value.splice(i, 1)
  } else {
    if (selected.value.length >= 6) selected.value.shift()
    selected.value.push(metric)
  }
  load()
}

function setDays(n) {
  days.value = n
  load()
}

const series = computed(() => {
  if (!data.value) return []
  return (data.value.metrics || []).map((m, i) => ({
    name: dictName(m),
    color: COLORS[i % COLORS.length],
    values: data.value.series[m] || [],
  }))
})

// 每个选中指标的 Top 维度（有 dim 才有意义，空维度会返回 []）。
const dimPanels = computed(() => {
  if (!data.value) return []
  const out = []
  for (const m of data.value.metrics || []) {
    const rows = (data.value.dims && data.value.dims[m]) || []
    if (!rows.length) continue
    out.push({
      metric: m,
      name: dictName(m),
      items: rows.map((r) => ({ label: r.dim, value: r.c, hint: `合计 ${Math.round(r.total)}` })),
    })
  }
  return out
})

function dictName(metric) {
  const hit = dict.value.find((d) => d.metric === metric)
  return hit ? hit.describe : metric
}

function unitOf(metric) {
  const hit = dict.value.find((d) => d.metric === metric)
  return hit ? hit.unit : ''
}

onMounted(async () => {
  await loadDict()
  await load()
})
</script>

<template>
  <div>
    <div v-if="error" class="alert">{{ error }}</div>

    <div class="toolbar">
      <button class="btn" :disabled="loading" @click="load">刷新</button>
      <div class="seg">
        <span
          v-for="n in [7, 14, 30]"
          :key="n"
          class="seg__item"
          :class="{ 'seg__item--active': days === n }"
          @click="setDays(n)"
        >
          {{ n }} 天
        </span>
      </div>
      <span class="muted">已选 {{ selected.length }} / 最多 6 条</span>
    </div>

    <!-- 指标选择 -->
    <div class="panel">
      <div class="panel__head">
        <div class="panel__title">指标字典</div>
        <div class="panel__hint">点击切换显示（白名单由后端维护）</div>
      </div>
      <div class="chips">
        <span
          v-for="d in dict"
          :key="d.metric"
          class="tag"
          :class="selected.includes(d.metric) ? 'tag--admin' : 'tag--muted'"
          style="cursor: pointer"
          :title="`${d.metric}（${d.unit}）`"
          @click="toggle(d.metric)"
        >
          {{ d.describe }}
        </span>
      </div>
    </div>

    <template v-if="data">
      <div class="panel" style="margin-top: 14px">
        <div class="panel__head">
          <div class="panel__title">指标趋势</div>
          <div class="panel__hint">
            {{ data.metrics.map((m) => `${dictName(m)}（${unitOf(m)}）`).join(' · ') }}
          </div>
        </div>
        <LineChart :labels="data.seriesDays" :series="series" :height="220" />
      </div>

      <div class="grid-2" style="margin-top: 14px">
        <div v-for="p in dimPanels" :key="p.metric" class="panel">
          <div class="panel__head">
            <div class="panel__title">{{ p.name }} · 维度分布</div>
            <div class="panel__hint">Top 8</div>
          </div>
          <BarList :items="p.items" />
        </div>
        <div v-if="!dimPanels.length" class="panel">
          <div class="panel__head">
            <div class="panel__title">维度分布</div>
          </div>
          <div class="bars__empty">所选指标没有维度数据（dim 为空）</div>
        </div>
      </div>
    </template>
  </div>
</template>
