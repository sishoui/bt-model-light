<!-- 诊断：失败趋势 + 错误码分布 + 空口质量（MTU/RSSI 直方图）+ OTA 流量（ADR-0037）。 -->
<script setup>
import { computed, onMounted, ref } from 'vue'
import { admin } from '../api.js'
import LineChart from '../components/LineChart.vue'
import BarList from '../components/BarList.vue'
import Histogram from '../components/Histogram.vue'

const days = ref(7)
const data = ref(null)
const error = ref('')
const loading = ref(false)

const SERIES = [
  ['error', '全部错误', '#ff383c'],
  ['ble.connect.fail', 'BLE 连接失败', '#ff8d28'],
  ['config.write.fail', '配置下发失败', '#af52de'],
  ['ota.fail', 'OTA 失败', '#ffcc00'],
  ['user.login.fail', '登录失败', '#5ac8fa'],
]

async function load() {
  loading.value = true
  error.value = ''
  try {
    data.value = await admin.errors({ days: days.value })
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

const series = computed(() => {
  if (!data.value) return []
  return SERIES.map(([m, name, color]) => ({ name, color, values: (data.value.series || {})[m] || [] }))
})

const codeItems = computed(() => {
  if (!data.value) return []
  return (data.value.codes || []).map((r) => ({ label: `错误码 ${r.dim}`, value: r.c }))
})

// 直方图标签：MTU 用整数，RSSI 加单位。
const mtuLabel = (b) => `${Math.round(b.from)}-${Math.round(b.to)}`
const rssiLabel = (b) => `${Math.round(b.from)}`
// 桶宽是 (520-20)/8=62.5，第一桶上限 82.5；「<64 字节」落在首桶，
// 所以按"含 64 以下"判定而不是 b.to <= 64（那样永不命中）。
const isSlowMtu = (b) => b.from < 64

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
      <div class="panel">
        <div class="panel__head">
          <div class="panel__title">失败趋势</div>
          <div class="panel__hint">{{ data.days }} 天 · 按 UTC 日</div>
        </div>
        <LineChart :labels="data.seriesDays" :series="series" :height="200" area />
      </div>

      <div class="grid-2" style="margin-top: 14px">
        <div class="panel">
          <div class="panel__head">
            <div class="panel__title">错误码分布</div>
            <div class="panel__hint">Top 12</div>
          </div>
          <BarList :items="codeItems" color="var(--danger)" empty-text="窗口内没有错误" />
        </div>

        <div class="panel">
          <div class="panel__head">
            <div class="panel__title">BLE 写分片上限定</div>
            <div class="panel__hint">红 = 慢分片</div>
          </div>
          <Histogram
            :buckets="data.mtu.buckets"
            :label-format="mtuLabel"
            :highlight="isSlowMtu"
            empty-text="窗口内没有连接记录"
          />
          <div class="panel__hint">
            共 {{ data.mtu.total }} 次连接 · 红色桶（&lt;64 字节）会让 OTA 非常慢
          </div>
        </div>

        <div class="panel">
          <div class="panel__head">
            <div class="panel__title">扫描信号强度分布</div>
            <div class="panel__hint">dBm，越靠右越强</div>
          </div>
          <Histogram
            :buckets="data.rssi.buckets"
            :label-format="rssiLabel"
            color="#34c759"
            empty-text="窗口内没有扫描记录"
          />
          <div class="panel__hint">共 {{ data.rssi.total }} 台次</div>
        </div>

        <div class="panel">
          <div class="panel__head">
            <div class="panel__title">OTA 写入流量</div>
            <div class="panel__hint">每日写入字节（约）</div>
          </div>
          <BarList
            :items="(data.otaBytes || []).map((r) => ({
              label: /^\d{4}-\d{2}-\d{2}$/.test(String(r.d)) ? String(r.d).slice(5) : String(r.d),
              value: Math.round((r.v || 0) / 1024),
            }))"
            unit=" KB"
            color="#af52de"
            empty-text="窗口内没有升级记录"
          />
        </div>
      </div>
    </template>
  </div>
</template>
