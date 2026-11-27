<!-- 后台根组件：登录门 + 侧栏导航 + 四个页面（概览/用户/设备/审计）。
     不用 vue-router：页面少、无深链需求，一个 active 状态足够。 -->

<script setup>
import { computed, onMounted, ref } from 'vue'
import { admin, getToken, setToken, ApiError } from './api.js'
import LoginView from './views/LoginView.vue'
import OverviewView from './views/OverviewView.vue'
import TelemetryView from './views/TelemetryView.vue'
import DiagnosticsView from './views/DiagnosticsView.vue'
import UsersView from './views/UsersView.vue'
import DevicesView from './views/DevicesView.vue'
import AuditView from './views/AuditView.vue'

const PAGES = [
  { key: 'overview', label: '概览' },
  { key: 'telemetry', label: '遥测' },
  { key: 'diagnostics', label: '诊断' },
  { key: 'users', label: '用户' },
  { key: 'devices', label: '设备' },
  { key: 'audit', label: '审计日志' },
]

const authed = ref(!!getToken())
const active = ref('overview')
const me = ref(null)
const bootError = ref('')
// 从用户页跳设备页时带上 userId 过滤。
const devicesFilter = ref('')

const currentPage = computed(() => PAGES.find((p) => p.key === active.value) || PAGES[0])

async function boot() {
  if (!getToken()) return
  try {
    // 后台没有 /admin/me：用 overview 探活即可，401 会自动清 token。
    await admin.overview()
    authed.value = true
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      setToken('')
      authed.value = false
    } else {
      bootError.value = err.message || String(err)
    }
  }
}

function onLoggedIn(payload) {
  me.value = payload.user
  authed.value = true
  bootError.value = ''
  active.value = 'overview'
}

async function onLogout() {
  try {
    await admin.logout()
  } catch (_e) {
    /* token 可能已失效，忽略 */
  }
  setToken('')
  me.value = null
  authed.value = false
}

function gotoDevicesOf(userId) {
  devicesFilter.value = String(userId)
  active.value = 'devices'
}

onMounted(boot)
</script>

<template>
  <LoginView v-if="!authed" @logged-in="onLoggedIn" />

  <div v-else class="shell">
    <aside class="sidebar">
      <div class="sidebar__brand">
        bt-model-light
        <small>管理后台</small>
      </div>
      <div
        v-for="p in PAGES"
        :key="p.key"
        class="nav-item"
        :class="{ 'nav-item--active': active === p.key }"
        @click="active = p.key"
      >
        {{ p.label }}
      </div>
    </aside>

    <main class="main">
      <div class="main__head">
        <div>
          <h2 class="main__title">{{ currentPage.label }}</h2>
          <p class="main__sub">
            <template v-if="me">已登录：{{ me.nickname || me.id }}</template>
            <template v-else>管理员会话</template>
          </p>
        </div>
        <button class="btn" @click="onLogout">退出登录</button>
      </div>

      <div v-if="bootError" class="alert">{{ bootError }}</div>

      <OverviewView v-if="active === 'overview'" />
      <TelemetryView v-else-if="active === 'telemetry'" />
      <DiagnosticsView v-else-if="active === 'diagnostics'" />
      <UsersView v-else-if="active === 'users'" @show-devices="gotoDevicesOf" />
      <DevicesView v-else-if="active === 'devices'" :initial-user-id="devicesFilter" />
      <AuditView v-else-if="active === 'audit'" />
    </main>
  </div>
</template>
