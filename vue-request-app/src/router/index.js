import { createRouter, createWebHistory } from 'vue-router';
import Index from '../components/Index.vue';

const History = () => import(/* webpackChunkName: "history" */ '../components/History.vue');
const BrowserProxy = () => import(/* webpackChunkName: "browser-proxy" */ '../components/BrowserProxy.vue');

const routes = [
  {
    path: '/',
    name: 'RequestForm',
    component: Index,
    meta: { title: 'API 请求 · FireflyProxy' }
  },
  {
    path: '/browser',
    name: 'BrowserProxy',
    component: BrowserProxy,
    meta: { title: '网页代理 · FireflyProxy' }
  },
  {
    path: '/history',
    name: 'HistoryRecord',
    component: History,
    meta: { title: '请求历史 · FireflyProxy' }
  }
];

const router = createRouter({
  // 设置基础路径为 /web，匹配后端静态资源挂载点
  history: createWebHistory('/web/'),
  routes,
  scrollBehavior() {
    return { top: 0 };
  }
});

// 路由守卫设置标题
router.beforeEach((to, from, next) => {
  document.title = to.meta.title || 'FireflyProxy';
  next();
});

export default router;
