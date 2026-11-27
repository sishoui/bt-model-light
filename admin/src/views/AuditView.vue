<script setup>
import { onMounted, ref } from 'vue'
import { admin } from '../api.js'

const page = ref(1)
const size = ref(50)
const total = ref(0)
const items = ref([])
const error = ref('')
const loading = ref(false)

const fmt = (ts) => (ts ? new Date(ts * 1000).toLocaleString('zh-CN') : '—')

// 动作码 → 中文（后端写的是稳定短码，界面自己加可读名）。
const ACTION_LABELS = {
  'admin.login': '管理员登录',
  'admin.login_failed': '管理员登录失败',
  'user.status': '修改用户状态',
  'device.delete': '删除设备',
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const r = await admin.audit({ page: page.value, size: size.value })
    items.value = r.items
    total.value = r.total
  } catch (err) {
    error.value = err.message || String(err)
  } finally {
    loading.value = false
  }
}

const pageCount = () => Math.max(1, Math.ceil(total.value / size.value))

onMounted(load)
</script>

<template>
  <div>
    <div v-if="error" class="alert">{{ error }}</div>

    <div class="toolbar">
      <button class="btn" :disabled="loading" @click="load">刷新</button>
      <span v-if="loading" class="muted">加载中…</span>
    </div>

    <div class="card table-wrap">
      <table>
        <thead>
          <tr>
            <th>时间</th>
            <th>操作者</th>
            <th>动作</th>
            <th>对象</th>
            <th>详情</th>
            <th>IP</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="a in items" :key="a.id">
            <td class="muted">{{ fmt(a.at) }}</td>
            <td class="mono">{{ a.actor }}</td>
            <td>{{ ACTION_LABELS[a.action] || a.action }}</td>
            <td class="mono">{{ a.target || '—' }}</td>
            <td class="mono muted">{{ a.detail || '—' }}</td>
            <td class="mono muted">{{ a.ip || '—' }}</td>
          </tr>
          <tr v-if="!items.length">
            <td colspan="6" class="empty">{{ loading ? '加载中…' : '暂无记录' }}</td>
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
