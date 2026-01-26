import { createRouter, createWebHistory } from 'vue-router';
import Index from '../components/Index.vue';
import History from '../components/History.vue';

const routes = [
  {
    path: '/',
    name: 'RequestForm',
    component: Index,
    meta: { title: '在线代理网站' }
  },
  {
    path: '/history',
    name: 'HistoryRecord',
    component: History,
    meta: { title: '请求历史记录' }
  }
];

const router = createRouter({
  // 设置基础路径为 /web，匹配后端静态资源挂载点
  history: createWebHistory('/web/'),
  routes,
});

// 路由守卫设置标题
router.beforeEach((to, from, next) => {
  document.title = to.meta.title || '在线代理网站';
  next();
});

export default router;