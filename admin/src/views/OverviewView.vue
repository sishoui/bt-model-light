<!-- 概览：关键指标卡 + 趋势折线 + 增长曲线 + 分布图（ADR-0037）。 -->
<script setup>
import { computed, onMounted, ref } from 'vue'
import { admin } from '../api.js'
import LineChart from '../components/LineChart.vue'
import BarList from '../components/BarList.vue'
import DonutChart from '../components/DonutChart.vue'
import Histogram from '../components/Histogram.vue'

const SERIES_COLORS = {
  'app.launch': '#0088ff',
  'user.login.ok': '#34c759',
  'ble.connect.ok': '#af52de',
  'config.write': '#ff8d28',
  error: '#ff383c',
}
const SERIES_NAMES = {
  'app.launch': '启动',
  'user.login.ok': '登录成功',
  'ble.connect.ok': 'BLE 连接',
  'config.write': '配置下发',
  error: '错误',
}

const days = ref(14)
const data = ref(null)
const error = ref('')
const loading = ref(false)
// 折线默认只显示 3 条（5 条挤在一起看不出趋势），可切换。
const visible = ref(['app.launch', 'ble.connect.ok', 'error'])

async function load() {
  loading.value = true
  error.value = ''
  try {
    data.value = await admin.overview({ days: days.value })
  } catch (err) {
    error.value = err.message || String(err)
  } finally {
    loading.value = false
  }
}

function setDays(n) {
  days.value = n
  load()
}

const trendSeries = computed(() => {
  if (!data.value) return []
  const t = data.value.trend
  return visible.value
    .filter((m) => t.series[m])
    .map((m) => ({ name: SERIES_NAMES[m] || m, color: SERIES_COLORS[m], values: t.series[m] }))
})

const growthSeries = computed(() => {
  if (!data.value) return []
  const g = data.value.userGrowth
  const d = data.value.deviceGrowth
  return [
    { name: '累计用户', color: '#0088ff', values: g.totalUsers },
    { name: '累计设备', color: '#34c759', values: d.totalDevices },
  ]
})

const newSeries = computed(() => {
  if (!data.value) return []
  return [
    { name: '新增用户', color: '#0088ff', values: data.value.userGrowth.newUsers },
    { name: '新增设备', color: '#ff8d28', values: data.value.deviceGrowth.newDevices },
  ]
})

const firmwareItems = computed(() => {
  if (!data.value) return []
  return (data.value.firmwareVersions || []).map((r) => ({
    label: r.v ? `v${r.v}` : '（未知）',
    value: r.c,
  }))
})

const errorCodeItems = computed(() => {
  if (!data.value) return []
  const list = (data.value.dims && data.value.dims.error) || []
  return list.map((r) => ({ label: `错误码 ${r.dim}`, value: r.c }))
})

const failItems = computed(() => {
  if (!data.value) return []
  const d = data.value.dims || {}
  const out = []
  for (const [m, label] of [
    ['ble.connect.fail', 'BLE 连接失败'],
    ['config.write.fail', '配置下发失败'],
    ['ota.fail', 'OTA 失败'],
    ['user.login.fail', '登录失败'],
  ]) {
    const total = (d[m] || []).reduce((s, r) => s + r.c, 0)
    if (total > 0) out.push({ label, value: total })
  }
  return out
})

function toggleSeries(m) {
  const i = visible.value.indexOf(m)
  if (i >= 0) visible.value.splice(i, 1)
  else visible.value.push(m)
}

onMounted(load)
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
      <span v-if="loading" class="muted">加载中…</span>
    </div>

    <template v-if="data">
      <!-- 指标卡 -->
      <div class="stats">
        <div class="stat">
          <div class="stat__label">用户总数</div>
          <div class="stat__value">{{ data.totalUsers }}</div>
          <div class="stat__hint">24h 新增 {{ data.newUsers24h }}</div>
        </div>
        <div class="stat">
          <div class="stat__label">设备总数</div>
          <div class="stat__value">{{ data.totalDevices }}</div>
          <div class="stat__hint">24h 活跃 {{ data.devices24h }}</div>
        </div>
        <div class="stat">
          <div class="stat__label">今日事件</div>
          <div class="stat__value">{{ data.eventsToday }}</div>
          <div class="stat__hint">登录 {{ data.loginsToday }}</div>
        </div>
        <div class="stat">
          <div class="stat__label">今日错误</div>
          <div class="stat__value" :style="{ color: data.errorsToday ? 'var(--danger)' : '' }">
            {{ data.errorsToday }}
          </div>
          <div class="stat__hint">已停用用户 {{ data.disabledUsers }}</div>
        </div>
      </div>

      <!-- 趋势折线 -->
      <div class="panel" style="margin-top: 14px">
        <div class="panel__head">
          <div class="panel__title">核心指标趋势</div>
          <div class="toolbar" style="margin: 0">
            <span
              v-for="m in Object.keys(SERIES_NAMES)"
              :key="m"
              class="tag"
              :class="visible.includes(m) ? 'tag--admin' : 'tag--muted'"
              style="cursor: pointer"
              @click="toggleSeries(m)"
            >
              {{ SERIES_NAMES[m] }}
            </span>
          </div>
        </div>
        <LineChart :labels="data.trend.days" :series="trendSeries" :height="200" />
        <div class="panel__hint">按 UTC 日聚合；只统计真实数据里的打点（小程序端上报）。</div>
      </div>

      <div class="grid-2" style="margin-top: 14px">
        <!-- 累计增长 -->
        <div class="panel">
          <div class="panel__head">
            <div class="panel__title">累计用户 / 设备</div>
            <div class="panel__hint">按注册时间累计</div>
          </div>
          <LineChart :labels="data.userGrowth.days" :series="growthSeries" :height="150" area />
        </div>

        <!-- 每日新增 -->
        <div class="panel">
          <div class="panel__head">
            <div class="panel__title">每日新增</div>
            <div class="panel__hint">{{ days }} 天窗口</div>
          </div>
          <LineChart :labels="data.userGrowth.days" :series="newSeries" :height="150" />
        </div>

        <!-- 固件版本分布 -->
        <div class="panel">
          <div class="panel__head">
            <div class="panel__title">设备固件版本分布</div>
            <div class="panel__hint">有多少老固件在跑</div>
          </div>
          <DonutChart :items="firmwareItems" :center-label="String(data.totalDevices)" />
        </div>

        <!-- 失败构成 -->
        <div class="panel">
          <div class="panel__head">
            <div class="panel__title">各类失败次数</div>
            <div class="panel__hint">{{ days }} 天</div>
          </div>
          <BarList :items="failItems" color="var(--danger)" empty-text="窗口内没有失败记录" />
        </div>

        <!-- 错误码 Top -->
        <div class="panel">
          <div class="panel__head">
            <div class="panel__title">错误码 Top</div>
            <div class="panel__hint">{{ days }} 天</div>
          </div>
          <BarList :items="errorCodeItems" color="var(--warning)" empty-text="窗口内没有错误" />
        </div>

        <!-- 空口分片 -->
        <div class="panel">
          <div class="panel__head">
            <div class="panel__title">BLE 写分片上限定分布</div>
            <div class="panel__hint">&lt;64 字节会拖慢 OTA</div>
          </div>
          <Histogram
            :buckets="data.mtuHistogram.buckets"
            :label-format="(b) => `${Math.round(b.from)}-${Math.round(b.to)}`"
            :highlight="(b) => b.from < 64"
            empty-text="窗口内没有连接记录"
          />
        </div>
      </div>
    </template>
  </div>
</template>
