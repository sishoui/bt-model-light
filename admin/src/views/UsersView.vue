<script setup>
import { onMounted, ref } from 'vue'
import { admin } from '../api.js'

const emit = defineEmits(['show-devices'])

const keyword = ref('')
const status = ref('')
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
    const r = await admin.users({
      keyword: keyword.value.trim(),
      status: status.value,
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

async function toggleStatus(user) {
  const next = user.status === 'active' ? 'disabled' : 'active'
  const verb = next === 'disabled' ? '停用' : '启用'
  if (!confirm(`确定${verb}用户「${user.nickname || user.id}」？`)) return
  try {
    await admin.setUserStatus(user.id, next)
    await load()
  } catch (err) {
    error.value = err.message || String(err)
  }
}

const pageCount = () => Math.max(1, Math.ceil(total.value / size.value))

onMounted(load)
</script>

<template>
  <div>
    <div v-if="error" class="alert">{{ error }}</div>

    <div class="toolbar">
      <input
        v-model="keyword"
        class="input"
        placeholder="搜索昵称 / openid / 用户名"
        @keyup.enter="search"
      />
      <select v-model="status" class="select" @change="search">
        <option value="">全部状态</option>
        <option value="active">正常</option>
        <option value="disabled">已停用</option>
      </select>
      <button class="btn btn--primary" :disabled="loading" @click="search">搜索</button>
      <button class="btn" :disabled="loading" @click="load">刷新</button>
    </div>

    <div class="card table-wrap">
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>昵称</th>
            <th>角色</th>
            <th>状态</th>
            <th>设备数</th>
            <th>最近登录</th>
            <th>注册时间</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="u in items" :key="u.id">
            <td class="mono">{{ u.id }}</td>
            <td>{{ u.nickname || '（未设置）' }}</td>
            <td>
              <span v-if="u.role === 'admin'" class="tag tag--admin">管理员</span>
              <span v-else class="tag tag--muted">用户</span>
            </td>
            <td>
              <span :class="u.status === 'active' ? 'tag tag--ok' : 'tag tag--off'">
                {{ u.status === 'active' ? '正常' : '已停用' }}
              </span>
            </td>
            <td>{{ u.deviceCount }}</td>
            <td class="muted">{{ fmt(u.lastLoginAt) }}</td>
            <td class="muted">{{ fmt(u.createdAt) }}</td>
            <td>
              <button class="btn btn--sm" @click="emit('show-devices', u.id)">设备</button>
              <button
                v-if="u.role !== 'admin'"
                class="btn btn--sm"
                :class="{ 'btn--danger': u.status === 'active' }"
                @click="toggleStatus(u)"
              >
                {{ u.status === 'active' ? '停用' : '启用' }}
              </button>
            </td>
          </tr>
          <tr v-if="!items.length">
            <td colspan="8" class="empty">{{ loading ? '加载中…' : '没有匹配的用户' }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="pager">
      <span>共 {{ total }} 条 · 第 {{ page }} / {{ pageCount() }} 页</span>
      <button class="btn btn--sm" :disabled="page <= 1 || loading" @click="page--, load()">上一页</button>
      <button
        class="btn btn--sm"
        :disabled="page >= pageCount() || loading"
        @click="page++, load()"
      >
        下一页
      </button>
    </div>
  </div>
</template>
