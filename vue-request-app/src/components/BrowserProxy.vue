<template>
    <main class="browser-page">
        <ModeSwitcher />

        <header class="page-hero">
            <div>
                <span class="eyebrow">BROWSER ROUTE</span>
                <h1>网页代理</h1>
                <p>通过服务端安全校验与资源重写打开目标网页，适合临时访问、兼容性检查和代理链路验证。</p>
            </div>
            <div class="security-badge">
                <span class="security-dot"></span>
                <div><strong>安全策略已启用</strong><small>URL、DNS、SSRF 与跳转逐跳校验</small></div>
            </div>
        </header>

        <div class="browser-grid">
            <el-card class="launch-card" shadow="never">
                <template #header>
                    <div class="card-heading">
                        <div>
                            <strong>打开目标网页</strong>
                            <span>请输入完整的 HTTP(S) 地址，不要在 URL 中携带账号、密码或敏感 Token。</span>
                        </div>
                        <el-tag type="primary" effect="plain">{{ enabledPreferenceCount }}/7 项兼容能力</el-tag>
                    </div>
                </template>

                <el-form label-position="top" @submit.prevent="openBrowser">
                    <el-form-item label="目标网页 URL">
                        <div class="url-composer">
                            <el-input
                                v-model="targetUrl"
                                size="large"
                                clearable
                                autocomplete="url"
                                placeholder="例如：https://example.com/docs"
                                aria-label="目标网页 URL"
                                @keyup.enter="openBrowser"
                            />
                            <el-button type="primary" size="large" @click="openBrowser">打开网页</el-button>
                        </div>
                    </el-form-item>

                    <div class="open-mode-section">
                        <span class="field-label">打开方式</span>
                        <el-radio-group v-model="openMode" class="mode-options">
                            <el-radio-button label="tab">
                                <span class="radio-title">新标签页</span>
                                <small>隔离更好，推荐日常使用</small>
                            </el-radio-button>
                            <el-radio-button label="embed" :disabled="!embedAllowed">
                                <span class="radio-title">嵌入预览</span>
                                <small>{{ embedAllowed ? '留在当前页面内查看' : '当前部署未启用' }}</small>
                            </el-radio-button>
                        </el-radio-group>
                    </div>

                    <el-alert v-if="!embedAllowed" class="mode-note" type="info" :closable="false" show-icon>
                        <template #title>为什么不能嵌入预览？</template>
                        当前 Browser Proxy 与管理页面同源。请使用新标签页，或为 <code>VUE_APP_PROXY_BROWSE_URL</code> 配置独立来源。
                    </el-alert>
                    <el-alert v-else-if="openMode === 'embed'" class="mode-note" type="warning" :closable="false" show-icon>
                        嵌入模式仍可能受第三方 Cookie、目标站防嵌入策略和浏览器隐私设置影响。
                    </el-alert>

                    <el-collapse class="compatibility-panel">
                        <el-collapse-item name="compatibility">
                            <template #title>
                                <div class="collapse-title">
                                    <strong>兼容设置</strong>
                                    <span>遇到页面资源、登录态或动态请求异常时再调整</span>
                                </div>
                            </template>
                            <div class="setting-list">
                                <div v-for="setting in preferenceSettings" :key="setting.key" class="setting-row">
                                    <div>
                                        <strong>{{ setting.label }}</strong>
                                        <span>{{ setting.description }}</span>
                                    </div>
                                    <el-switch
                                        v-model="preferences[setting.key]"
                                        :aria-label="setting.label"
                                        inline-prompt
                                        active-text="开"
                                        inactive-text="关"
                                    />
                                </div>
                            </div>
                            <el-alert
                                class="preference-alert"
                                title="这些开关只能关闭服务端已允许的能力，不能绕过后端全局策略；设置会应用到本次浏览会话。"
                                type="info"
                                :closable="false"
                                show-icon
                            />
                        </el-collapse-item>
                    </el-collapse>
                </el-form>
            </el-card>

            <aside class="safety-panel">
                <div class="safety-icon">⌁</div>
                <h2>使用前请留意</h2>
                <ul>
                    <li><strong>不可信脚本：</strong>目标站点提供的代码会在浏览器中执行。</li>
                    <li><strong>链接可见性：</strong>目标 URL 可能进入浏览器历史和服务端日志。</li>
                    <li><strong>来源隔离：</strong>生产环境建议将 Browser Proxy 部署在独立 Origin。</li>
                    <li><strong>能力边界：</strong>代理不能保证所有登录、支付或强风控页面正常工作。</li>
                </ul>
                <div class="safety-footnote">建议仅打开你信任或明确需要检查的站点。</div>
            </aside>
        </div>

        <section v-if="previewUrl && openMode === 'embed'" class="preview-shell">
            <div class="preview-heading">
                <div><span class="preview-dot"></span><strong>嵌入预览</strong></div>
                <el-button text type="primary" @click="openInNewTab(previewUrl)">转到新标签页</el-button>
            </div>
            <iframe
                :src="previewUrl"
                title="Browser Proxy 嵌入预览"
                sandbox="allow-downloads allow-forms allow-modals allow-popups allow-same-origin allow-scripts allow-top-navigation-by-user-activation"
            />
        </section>
    </main>
</template>

<script>
import { ElMessage } from 'element-plus';
import { PROXY_CONFIG } from '../config.js';
import {
    DEFAULT_BROWSER_PREFERENCES,
    buildBrowserEntryUrl,
    canEmbedBrowserProxy,
    normalizeBrowserTarget
} from '../utils/browserProxy.mjs';
import ModeSwitcher from './ModeSwitcher.vue';

export default {
    name: 'BrowserProxy',
    components: { ModeSwitcher },
    data() {
        return {
            targetUrl: '',
            openMode: 'tab',
            previewUrl: '',
            preferences: { ...DEFAULT_BROWSER_PREFERENCES },
            preferenceSettings: [
                { key: 'rewriteHtml', label: 'HTML 资源重写', description: '重写页面中的资源、导航和表单地址，使它们继续经过代理。' },
                { key: 'rewriteCss', label: 'CSS 资源重写', description: '重写样式表里的 url() 与 @import 资源地址。' },
                { key: 'cookieJar', label: '服务端 Cookie Jar', description: '在当前代理会话中保存并发送上游 Cookie，用于维持登录态。' },
                { key: 'compatHeaders', label: '兼容响应头', description: '按服务端许可调整影响嵌入和跨源展示的响应头。' },
                { key: 'runtimeBridge', label: '运行时请求桥接', description: '映射 fetch、XHR、EventSource、window.open 与动态 History URL。' },
                { key: 'scriptCookieBridge', label: '脚本 Cookie 桥接', description: '按上游 Origin 隔离 document.cookie，并同步到后续上游请求。' },
                { key: 'webSocket', label: 'WebSocket 代理', description: '映射 ws/wss 地址，通过受限 Upgrade 通道转发双向消息。' }
            ]
        };
    },
    computed: {
        embedAllowed() {
            return canEmbedBrowserProxy(window.location.origin, PROXY_CONFIG.BROWSER_BASE_URL);
        },
        enabledPreferenceCount() {
            return Object.values(this.preferences).filter(Boolean).length;
        }
    },
    mounted() {
        this.$emit('update-message', true);
        const target = normalizeBrowserTarget(this.$route.query.url);
        if (target) this.targetUrl = target;
    },
    methods: {
        openInNewTab(url) {
            window.open(url, '_blank', 'noopener,noreferrer');
        },
        openBrowser() {
            const target = normalizeBrowserTarget(this.targetUrl);
            if (!target) {
                ElMessage.error('请输入不含用户名和密码的完整 HTTP(S) URL。');
                return;
            }

            let entryUrl;
            try {
                entryUrl = buildBrowserEntryUrl(PROXY_CONFIG.BROWSER_BASE_URL, target, this.preferences);
            } catch {
                ElMessage.error('Browser Proxy 地址配置无效，请检查 VUE_APP_PROXY_BROWSE_URL。');
                return;
            }
            if (this.openMode === 'embed' && this.embedAllowed) {
                this.previewUrl = entryUrl;
                return;
            }
            this.previewUrl = '';
            this.openInNewTab(entryUrl);
        }
    }
};
</script>

<style scoped>
.browser-page {
    width: min(1180px, calc(100% - 40px));
    min-height: calc(100vh - 70px);
    margin: 0 auto;
    padding: 24px 0 34px;
}

.page-hero {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 24px;
    margin-bottom: 18px;
    padding: 18px 4px 4px;
    text-align: left;
}

.eyebrow { color: #1677ff; font-size: 11px; font-weight: 800; letter-spacing: 0.16em; }
h1 { margin: 6px 0 7px; font-size: clamp(28px, 4vw, 38px); letter-spacing: -0.04em; }
.page-hero p { max-width: 710px; margin: 0; color: #667085; line-height: 1.7; }

.security-badge {
    display: flex;
    align-items: center;
    gap: 11px;
    min-width: 250px;
    padding: 13px 15px;
    border: 1px solid #ccebd9;
    border-radius: 13px;
    background: #f3fbf6;
}

.security-dot { flex: 0 0 10px; width: 10px; height: 10px; border-radius: 50%; background: #24a148; box-shadow: 0 0 0 5px rgba(36, 161, 72, 0.12); }
.security-badge div { display: grid; gap: 3px; }
.security-badge strong { color: #16733b; font-size: 13px; }
.security-badge small { color: #61816c; font-size: 11px; }

.browser-grid { display: grid; grid-template-columns: minmax(0, 1fr) 285px; align-items: start; gap: 18px; }
.launch-card { border-color: #e4eaf2; border-radius: 15px; text-align: left; }
.card-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.card-heading > div { display: grid; gap: 5px; }
.card-heading strong { font-size: 16px; }
.card-heading span { color: #7b8798; font-size: 12px; line-height: 1.6; }

.url-composer { display: grid; grid-template-columns: minmax(0, 1fr) auto; width: 100%; gap: 10px; }
.url-composer :deep(.el-button) { min-width: 116px; }

.open-mode-section { display: grid; gap: 9px; margin-top: 6px; }
.field-label { color: #344054; font-size: 14px; font-weight: 600; }
.mode-options { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.mode-options :deep(.el-radio-button) { width: 100%; }
.mode-options :deep(.el-radio-button__inner) { display: grid; width: 100%; padding: 13px 16px; text-align: left; border: 1px solid #dfe5ed !important; border-radius: 10px !important; box-shadow: none !important; }
.mode-options :deep(.el-radio-button.is-active .el-radio-button__inner) { border-color: #1677ff !important; background: #eef5ff; }
.radio-title { color: #344054; font-weight: 700; }
.mode-options small { margin-top: 3px; color: #8a94a6; font-size: 11px; }
.mode-note { margin-top: 14px; }
.mode-note code { font-size: 12px; }

.compatibility-panel { margin-top: 19px; border-top: 1px solid #edf0f5; }
.collapse-title { display: flex; align-items: center; gap: 9px; }
.collapse-title span { color: #98a2b3; font-size: 12px; font-weight: 400; }
.setting-list { display: grid; grid-template-columns: 1fr 1fr; gap: 0 24px; }
.setting-row { display: flex; align-items: center; justify-content: space-between; gap: 14px; min-height: 74px; padding: 12px 4px; border-bottom: 1px solid #edf0f5; }
.setting-row > div { display: grid; gap: 4px; }
.setting-row strong { color: #344054; font-size: 13px; }
.setting-row span { color: #7b8798; font-size: 12px; line-height: 1.5; }
.preference-alert { margin-top: 15px; }

.safety-panel { padding: 22px; text-align: left; border: 1px solid #f0dfbf; border-radius: 15px; background: #fffaf0; }
.safety-icon { display: grid; width: 38px; height: 38px; margin-bottom: 14px; place-items: center; color: #b26a00; font-size: 23px; border-radius: 10px; background: #fff0cf; }
.safety-panel h2 { margin: 0; color: #694400; font-size: 16px; }
.safety-panel ul { display: grid; gap: 13px; margin: 17px 0; padding-left: 18px; color: #745b31; font-size: 12px; line-height: 1.65; }
.safety-footnote { padding-top: 14px; color: #9a7640; font-size: 11px; border-top: 1px solid #f1dfbd; }

.preview-shell { overflow: hidden; margin-top: 20px; text-align: left; border: 1px solid #dfe5ed; border-radius: 15px; background: #fff; }
.preview-heading { display: flex; align-items: center; justify-content: space-between; padding: 11px 16px; border-bottom: 1px solid #edf0f5; }
.preview-heading > div { display: flex; align-items: center; gap: 8px; }
.preview-dot { width: 8px; height: 8px; border-radius: 50%; background: #24a148; }
iframe { display: block; width: 100%; height: 70vh; border: 0; background: #fff; }

@media (max-width: 900px) {
    .browser-grid { grid-template-columns: 1fr; }
    .setting-list { grid-template-columns: 1fr; }
}

@media (max-width: 680px) {
    .browser-page { width: min(100% - 24px, 1180px); padding-top: 12px; }
    .page-hero { align-items: flex-start; flex-direction: column; gap: 14px; padding-top: 10px; }
    .security-badge { width: 100%; min-width: 0; }
    .card-heading { flex-direction: column; }
    .url-composer,
    .mode-options { grid-template-columns: 1fr; }
    .url-composer :deep(.el-button) { width: 100%; }
    .collapse-title { align-items: flex-start; flex-direction: column; gap: 2px; }
    .launch-card :deep(.el-card__body) { padding: 15px; }
}
</style>
