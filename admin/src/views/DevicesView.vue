<script setup>
import { onMounted, ref, watch } from 'vue'
import { admin } from '../api.js'

const props = defineProps({ initialUserId: { type: String, default: '' } })

const keyword = ref('')
const userId = ref(props.initialUserId || '')
const page = ref(1)
const size = ref(20)
const total = ref(0)
const items = ref([])
const error = ref('')
const loading = ref(false)

const fmt = (ts) => (ts ? new Date(ts * 1000).toLocaleString('zh-CN') : '—')

async function load() {
  loading.value = true
  error.value = ''
  try {
    const r = await admin.devices({
      keyword: keyword.value.trim(),
      userId: userId.value,
      page: page.value,
      size: size.value,
    })
    items.value = r.items
    total.value = r.total
  } catch (err) {
    error.value = err.message || String(err)
  } finally {
    loading.value = false
  }
}

function search() {
  page.value = 1
  load()
}

async function remove(dev) {
  if (!confirm(`确定删除设备「${dev.name || dev.deviceId}」？\n（只删云端记录，不影响设备本身）`)) return
  try {
    await admin.deleteDevice(dev.id)
    await load()
  } catch (err) {
    error.value = err.message || String(err)
  }
}

const pageCount = () => Math.max(1, Math.ceil(total.value / size.value))

watch(
  () => props.initialUserId,
  (v) => {
    userId.value = v || ''
    if (v) search()
  },
)

onMounted(load)
</script>

<template>
  <div>
    <div v-if="error" class="alert">{{ error }}</div>

    <div class="toolbar">
      <input
        v-model="keyword"
        class="input"
        placeholder="搜索设备名 / BLE deviceId"
        @keyup.enter="search"
      />
      <input v-model="userId" class="input" style="min-width: 120px" placeholder="按用户 ID 过滤" @keyup.enter="search" />
      <button class="btn btn--primary" :disabled="loading" @click="search">搜索</button>
      <button class="btn" :disabled="loading" @click="load">刷新</button>
    </div>

    <div class="card table-wrap">
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>设备名</th>
            <th>BLE deviceId</th>
            <th>归属用户</th>
            <th>固件</th>
            <th>最近上报</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="d in items" :key="d.id">
            <td class="mono">{{ d.id }}</td>
            <td>{{ d.name || '（未命名）' }}</td>
            <td class="mono">{{ d.deviceId }}</td>
            <td>
              {{ d.ownerNickname || '（未设置昵称）' }}
              <span class="muted mono">#{{ d.userId }}</span>
            </td>
            <td>{{ d.firmwareVersion ? 'v' + d.firmwareVersion : '—' }}</td>
            <td class="muted">{{ fmt(d.lastSeenAt) }}</td>
            <td>
              <button class="btn btn--sm btn--danger" @click="remove(d)">删除</button>
            </td>
          </tr>
          <tr v-if="!items.length">
            <td colspan="7" class="empty">{{ loading ? '加载中…' : '没有匹配的设备' }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="pager">
      <span>共 {{ total }} 条 · 第 {{ page }} / {{ pageCount() }} 页</span>
      <button class="btn btn--sm" :disabled="page <= 1 || loading" @click="page--, load()">上一页</button>
      <button class="btn btn--sm" :disabled="page >= pageCount() || loading" @click="page++, load()">
        下一页
      </button>
    </div>
  </div>
</template>
