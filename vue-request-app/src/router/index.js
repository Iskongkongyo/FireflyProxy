import { createRouter, createWebHistory } from 'vue-router';
import Index from '../components/Index.vue';
import History from '../components/History.vue';

const routes = [
  {
    path: '/web',
    name: 'RequestForm',
    component: Index,
	meta: { title: '在线代理网站' }
  },
  {
    path: '/web/history',
    name: 'HistoryRecord',
    component: History,
	meta: { title: '请求历史记录' }
  }
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

// 路由守卫设置标题
router.beforeEach((to, from, next) => {
document.title = to.meta.title || '在线代理网站';
next();
});

export default router;