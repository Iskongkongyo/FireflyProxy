<template>
    <el-container class="browser-page">
        <el-header height="auto">
            <h1>网页代理</h1>
            <p>通过 Browser Route 打开经过安全校验和静态资源重写的网页。</p>
        </el-header>
        <el-main>
            <ModeSwitcher />

            <el-alert
                class="security-alert"
                title="网页代理会执行目标站点提供的不可信代码"
                type="warning"
                :closable="false"
                show-icon
            >
                <template #default>
                    建议将 Browser Proxy 部署到与管理 UI 不同的 Origin。目标 URL 及其查询参数可能进入浏览器历史，请勿把敏感 Token 放入可分享链接。
                </template>
            </el-alert>

            <el-card class="launch-card" shadow="never">
                <el-form label-position="top" @submit.prevent="openBrowser">
                    <el-form-item label="目标网页 URL">
                        <el-input
                            v-model="targetUrl"
                            size="large"
                            clearable
                            autocomplete="url"
                            placeholder="https://example.com"
                            @keyup.enter="openBrowser"
                        />
                    </el-form-item>

                    <div class="launch-options">
                        <el-radio-group v-model="openMode">
                            <el-radio-button label="tab">新标签页（推荐）</el-radio-button>
                            <el-radio-button label="embed" :disabled="!embedAllowed">嵌入预览</el-radio-button>
                        </el-radio-group>
                        <el-button type="primary" size="large" @click="openBrowser">
                            打开网页
                        </el-button>
                    </div>

                    <p v-if="!embedAllowed" class="mode-note">
                        当前 Browser Proxy 与管理 UI 同源，已禁用嵌入预览；请使用新标签页或配置独立的 <code>VUE_APP_PROXY_BROWSE_URL</code>。
                    </p>
                    <p v-else-if="openMode === 'embed'" class="mode-note">
                        嵌入模式可能受第三方 Cookie、目标站防嵌入策略和浏览器隐私设置影响。
                    </p>

                    <el-collapse class="compatibility-panel">
                        <el-collapse-item title="兼容设置（高级）" name="compatibility">
                            <div class="setting-row">
                                <div>
                                    <strong>HTML Rewrite</strong>
                                    <span>重写页面资源、导航和表单 URL</span>
                                </div>
                                <el-switch v-model="preferences.rewriteHtml" />
                            </div>
                            <div class="setting-row">
                                <div>
                                    <strong>CSS Rewrite</strong>
                                    <span>重写 CSS url() 与 @import</span>
                                </div>
                                <el-switch v-model="preferences.rewriteCss" />
                            </div>
                            <div class="setting-row">
                                <div>
                                    <strong>Cookie Jar</strong>
                                    <span>在服务端 Session 内维持 upstream Cookie</span>
                                </div>
                                <el-switch v-model="preferences.cookieJar" />
                            </div>
                            <div class="setting-row">
                                <div>
                                    <strong>Compatibility Headers</strong>
                                    <span>按服务器许可移除不兼容的嵌入与跨源策略头</span>
                                </div>
                                <el-switch v-model="preferences.compatHeaders" />
                            </div>
                            <div class="setting-row disabled-setting">
                                <div>
                                    <strong>Runtime Bridge</strong>
                                    <span>尚未实现，将在 P2 阶段提供</span>
                                </div>
                                <el-switch :model-value="false" disabled />
                            </div>
                            <el-alert
                                title="这些开关只能关闭服务器已允许的能力，不能绕过后端全局配置。最近一次启动设置会应用到同一 Browser Session。"
                                type="info"
                                :closable="false"
                                show-icon
                            />
                        </el-collapse-item>
                    </el-collapse>
                </el-form>
            </el-card>

            <section v-if="previewUrl && openMode === 'embed'" class="preview-shell">
                <div class="preview-heading">
                    <strong>嵌入预览</strong>
                    <el-button text type="primary" @click="openInNewTab(previewUrl)">转到新标签页</el-button>
                </div>
                <iframe
                    :src="previewUrl"
                    title="Browser Proxy 嵌入预览"
                    sandbox="allow-downloads allow-forms allow-modals allow-popups allow-same-origin allow-scripts allow-top-navigation-by-user-activation"
                />
            </section>
        </el-main>
    </el-container>
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
            preferences: { ...DEFAULT_BROWSER_PREFERENCES }
        };
    },
    computed: {
        embedAllowed() {
            return canEmbedBrowserProxy(window.location.origin, PROXY_CONFIG.BROWSER_BASE_URL);
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
                entryUrl = buildBrowserEntryUrl(
                    PROXY_CONFIG.BROWSER_BASE_URL,
                    target,
                    this.preferences
                );
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
    min-height: calc(100vh - 120px);
    padding-bottom: 80px;
}

h1 {
    margin: 12px 0 4px;
    color: #409eff;
    font-size: 40px;
}

header p {
    margin: 0 0 18px;
    color: #606266;
}

.security-alert,
.launch-card,
.preview-shell {
    width: min(960px, 100%);
    margin: 0 auto 20px;
    text-align: left;
}

.launch-options,
.preview-heading,
.setting-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
}

.mode-note {
    margin: 12px 0 0;
    color: #909399;
    font-size: 13px;
}

.compatibility-panel {
    margin-top: 22px;
}

.setting-row {
    padding: 12px 4px;
    border-bottom: 1px solid #ebeef5;
}

.setting-row div {
    display: flex;
    flex-direction: column;
    gap: 4px;
}

.setting-row span {
    color: #909399;
    font-size: 13px;
}

.disabled-setting {
    opacity: 0.65;
}

.preview-shell {
    overflow: hidden;
    border: 1px solid #dcdfe6;
    border-radius: 12px;
    background: #fff;
}

.preview-heading {
    padding: 10px 16px;
    border-bottom: 1px solid #ebeef5;
}

iframe {
    display: block;
    width: 100%;
    height: 70vh;
    border: 0;
    background: #fff;
}

@media (max-width: 768px) {
    h1 {
        font-size: 32px;
    }

    .launch-options {
        align-items: stretch;
        flex-direction: column;
    }

    .launch-options :deep(.el-radio-group),
    .launch-options :deep(.el-button) {
        width: 100%;
    }

    .launch-options :deep(.el-radio-button) {
        flex: 1;
    }

    .launch-options :deep(.el-radio-button__inner) {
        width: 100%;
    }
}
</style>
