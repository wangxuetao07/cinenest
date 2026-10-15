import { createApp } from 'vue';
import { createPinia } from 'pinia';
import naive from 'naive-ui';

import App from './App.vue';
import router from './router';
import { useAuthStore } from './stores/auth';
import './styles/main.css';

const app = createApp(App);
const pinia = createPinia();

app.use(pinia);
app.use(router);
app.use(naive);

// 会话失效（401）：清空本地身份并回到登录页
window.addEventListener('cn:unauthorized', () => {
  const auth = useAuthStore(pinia);
  const current = router.currentRoute.value;
  auth.clear();
  if (current.name !== 'login') {
    router.replace({ name: 'login', query: current.fullPath === '/' ? {} : { redirect: current.fullPath } });
  }
});

app.mount('#app');
