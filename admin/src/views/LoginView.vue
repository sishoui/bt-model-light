<script setup>
import { ref } from 'vue'
import { admin, setToken } from '../api.js'

const emit = defineEmits(['logged-in'])

const username = ref('')
const password = ref('')
const error = ref('')
const busy = ref(false)

async function submit() {
  if (busy.value) return
  error.value = ''
  if (!username.value || !password.value) {
    error.value = '请输入用户名与密码'
    return
  }
  busy.value = true
  try {
    const r = await admin.login(username.value.trim(), password.value)
    setToken(r.token)
    password.value = ''
    emit('logged-in', r)
  } catch (err) {
    error.value = err.message || String(err)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="login-wrap">
    <form class="login-card" @submit.prevent="submit">
      <h1>管理后台</h1>
      <p>bt-model-light 用户与设备管理</p>

      <div v-if="error" class="alert">{{ error }}</div>

      <label for="username">用户名</label>
      <input id="username" v-model="username" class="input" autocomplete="username" />

      <label for="password">密码</label>
      <input id="password" v-model="password" type="password" class="input" autocomplete="current-password" />

      <button class="btn btn--primary" type="submit" :disabled="busy">
        {{ busy ? '登录中…' : '登录' }}
      </button>
    </form>
  </div>
</template>
