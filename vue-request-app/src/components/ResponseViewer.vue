<template>
	<el-card class="response-card" shadow="never">
		<template #header>
			<div class="response-header">
				<div class="response-title"><span class="response-indicator"></span><strong>响应结果</strong></div>
				<div class="response-stats">
					<el-tag v-if="status !== null" :type="statusTagType" size="small">
						HTTP {{ status }}{{ statusText ? ` ${statusText}` : '' }}
					</el-tag>
					<el-tag v-if="responseTime" type="info" size="small">
						⏱️ {{ responseTime }}ms
					</el-tag>
					<el-tag v-if="responseSize" type="success" size="small">
						📦 {{ formatSize(responseSize) }}
					</el-tag>
				</div>
			</div>
		</template>

		<div v-if="hasDiagnostics && !loading" class="diagnostics-panel">
			<el-descriptions :column="2" border size="small">
				<el-descriptions-item label="状态">
					{{ status }}{{ statusText ? ` ${statusText}` : '' }}
				</el-descriptions-item>
				<el-descriptions-item label="总耗时">{{ responseTime }} ms</el-descriptions-item>
				<el-descriptions-item label="响应大小">{{ formatSize(responseSize) }}</el-descriptions-item>
				<el-descriptions-item label="Content-Type">{{ contentType || '未提供' }}</el-descriptions-item>
				<el-descriptions-item label="最终 URL" :span="2">
					<span class="diagnostic-url">{{ finalUrl || '未知' }}</span>
				</el-descriptions-item>
			</el-descriptions>
			<el-alert v-if="diagnosticsTruncated" title="诊断响应头达到安全大小上限，部分 URL 或跳转项已截断。"
				type="warning" :closable="false" show-icon />
			<div v-if="redirectChain.length" class="redirect-chain">
				<div class="redirect-chain-title">重定向链路</div>
				<el-timeline>
					<el-timeline-item v-for="(hop, index) in redirectChain" :key="`${index}-${hop.url}`"
						:type="hop.followed ? 'primary' : 'warning'" :timestamp="`${hop.status} · ${hop.method}`">
						<div class="redirect-hop-url">{{ hop.url }}</div>
						<div class="redirect-arrow">→ {{ hop.location }}</div>
						<el-tag size="small" :type="hop.followed ? 'success' : 'warning'">
							{{ hop.followed ? '已跟随' : '未跟随' }}
						</el-tag>
					</el-timeline-item>
					<el-timeline-item type="success" timestamp="最终响应">
						<div class="redirect-hop-url">{{ finalUrl }}</div>
					</el-timeline-item>
				</el-timeline>
			</div>
		</div>
		
		<!-- Loading 状态指示器 -->
		<div v-if="loading" class="loading-container">
			<div class="loading-spinner">
				<div class="spinner-ring"></div>
				<div class="spinner-ring"></div>
				<div class="spinner-ring"></div>
			</div>
			<div class="loading-text">
				<span class="loading-dots">请求中</span>
				<p class="loading-hint">正在获取响应数据...</p>
			</div>
		</div>
		
		<!-- JSON 响应 (带语法高亮) -->
		<div v-else-if="type === 'json'" class="code-container">
			<div class="code-toolbar">
				<el-button size="small" @click="copyContent" class="copy-btn">
					<el-icon><CopyDocument /></el-icon>
					复制
				</el-button>
				<el-button size="small" @click="toggleWrap" class="wrap-btn">
					{{ wordWrap ? '取消换行' : '自动换行' }}
				</el-button>
			</div>
			<pre :class="['response-code', 'hljs', { 'word-wrap': wordWrap }]"><code v-html="highlightedContent"></code></pre>
		</div>
		
		<!-- 纯文本响应 -->
		<div v-else-if="type === 'text'">
			<pre class="response-content">{{ content }}</pre>
		</div>
		
		<!-- Image -->
		<div v-else-if="type === 'image'" class="media-container">
			<img :src="url" alt="Response Image" class="response-media" loading="lazy" />
		</div>
		
		<!-- Video -->
		<div v-else-if="type === 'video'" class="media-container">
			<video controls :src="url" class="response-media" preload="metadata"></video>
			<p v-if="isStreaming" class="streaming-hint">🎬 流媒体模式：边播放边加载</p>
		</div>
		
		<!-- Audio -->
		<div v-else-if="type === 'audio'" class="media-container">
			<audio controls :src="url" class="response-audio" preload="metadata"></audio>
			<p v-if="isStreaming" class="streaming-hint">🎵 流媒体模式：边播放边加载</p>
		</div>
		
		<!-- File Download -->
		<div v-else-if="type === 'file'" class="file-container">
			<div class="file-icon">📄</div>
			<div class="file-info">
				<span class="file-name">{{ fileName || '未知文件' }}</span>
				<el-button type="primary" @click="downloadFile" size="small">
					<el-icon class="el-icon--left"><Download /></el-icon>
					下载文件
				</el-button>
			</div>
		</div>
		
		<!-- HEAD Response -->
		<div v-else-if="type === 'head'">
			<pre class="response-content">{{ formatHeaders(headers) }}</pre>
		</div>
		
		<!-- Empty / Default -->
		<div v-else class="empty-state">
			<div class="empty-icon">⇄</div>
			<strong>等待发送请求</strong>
			<p class="empty-text">响应状态、耗时、跳转链路和正文会显示在这里。</p>
			<span class="empty-shortcut">Ctrl / ⌘ + Enter 快速发送</span>
		</div>
	</el-card>
</template>

<script>
import hljs from 'highlight.js/lib/core';
import json from 'highlight.js/lib/languages/json';
import 'highlight.js/styles/github.css';
import { ElMessage } from 'element-plus';

// 注册 JSON 语言
hljs.registerLanguage('json', json);

export default {
	name: 'ResponseViewer',
	props: {
		type: { type: String, default: '' },
		content: { type: String, default: '' },
		url: { type: String, default: '' },
		headers: { type: [Object, String], default: '' },
		fileName: { type: String, default: '' },
		isStreaming: { type: Boolean, default: false },
		loading: { type: Boolean, default: false },
		responseTime: { type: Number, default: 0 },
		responseSize: { type: Number, default: 0 },
		status: { type: Number, default: null },
		statusText: { type: String, default: '' },
		finalUrl: { type: String, default: '' },
		redirectChain: { type: Array, default: () => [] },
		contentType: { type: String, default: '' },
		diagnosticsTruncated: { type: Boolean, default: false }
	},
	data() {
		return {
			wordWrap: true
		};
	},
	computed: {
		hasDiagnostics() {
			return this.status !== null;
		},
		statusTagType() {
			if (this.status >= 200 && this.status < 300) return 'success';
			if (this.status >= 300 && this.status < 400) return 'warning';
			return 'danger';
		},
		highlightedContent() {
			if (!this.content) return '';
			try {
				const result = hljs.highlight(this.content, { language: 'json' });
				return result.value;
			} catch (e) {
				return this.escapeHtml(this.content);
			}
		}
	},
	methods: {
		formatSize(bytes) {
			if (!Number.isFinite(bytes) || bytes < 0) return '未知';
			const units = ['B', 'KB', 'MB', 'GB'];
			let unitIndex = 0;
			let size = bytes;
			while (size >= 1024 && unitIndex < units.length - 1) {
				size /= 1024;
				unitIndex++;
			}
			return `${size.toFixed(1)} ${units[unitIndex]}`;
		},
		formatHeaders(headers) {
			if (typeof headers === 'string') return headers;
			return JSON.stringify(headers, null, 2);
		},
		escapeHtml(text) {
			const div = document.createElement('div');
			div.textContent = text;
			return div.innerHTML;
		},
		async copyContent() {
			try {
				await navigator.clipboard.writeText(this.content);
				ElMessage.success('已复制到剪贴板');
			} catch (e) {
				ElMessage.error('复制失败');
			}
		},
		toggleWrap() {
			this.wordWrap = !this.wordWrap;
		},
		downloadFile() {
			if (!this.url) return;
			const link = document.createElement('a');
			link.href = this.url;
			link.download = this.fileName || 'download';
			link.style.display = 'none';
			document.body.appendChild(link);
			link.click();
			document.body.removeChild(link);
		}
	}
};
</script>

<style scoped>
.response-card {
	margin-top: 16px;
	border-color: #e4eaf2;
	border-radius: 15px;
	text-align: left;
}

.response-header {
	display: flex;
	justify-content: space-between;
	align-items: center;
	flex-wrap: wrap;
	gap: 8px;
}

.response-stats {
	display: flex;
	gap: 8px;
	flex-wrap: wrap;
}

.response-title { display: flex; align-items: center; gap: 9px; }
.response-indicator { width: 8px; height: 8px; border-radius: 50%; background: #1677ff; box-shadow: 0 0 0 5px rgba(22, 119, 255, 0.1); }

.diagnostics-panel { display: grid; gap: 14px; margin-bottom: 16px; }
.diagnostic-url, .redirect-hop-url, .redirect-arrow { overflow-wrap: anywhere; font-family: monospace; }
.redirect-chain { padding: 4px 8px 0; }
.redirect-chain-title { font-weight: 600; margin-bottom: 12px; }
.redirect-arrow { color: #606266; margin: 5px 0 8px; }

/* Loading 动画 */
.loading-container {
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	padding: 60px 20px;
}

.loading-spinner {
	position: relative;
	width: 60px;
	height: 60px;
}

.spinner-ring {
	position: absolute;
	width: 100%;
	height: 100%;
	border: 3px solid transparent;
	border-radius: 50%;
	animation: spin 1.2s linear infinite;
}

.spinner-ring:nth-child(1) {
	border-top-color: #409eff;
	animation-delay: 0s;
}

.spinner-ring:nth-child(2) {
	border-right-color: #67c23a;
	animation-delay: 0.15s;
	width: 80%;
	height: 80%;
	top: 10%;
	left: 10%;
}

.spinner-ring:nth-child(3) {
	border-bottom-color: #e6a23c;
	animation-delay: 0.3s;
	width: 60%;
	height: 60%;
	top: 20%;
	left: 20%;
}

@keyframes spin {
	to { transform: rotate(360deg); }
}

.loading-text {
	margin-top: 20px;
	text-align: center;
}

.loading-dots::after {
	content: '';
	animation: dots 1.5s infinite;
}

@keyframes dots {
	0%, 20% { content: '.'; }
	40% { content: '..'; }
	60%, 100% { content: '...'; }
}

.loading-hint {
	color: #909399;
	font-size: 13px;
	margin-top: 8px;
}

/* 代码容器 */
.code-container {
	position: relative;
}

.code-toolbar {
	display: flex;
	justify-content: flex-end;
	gap: 8px;
	margin-bottom: 8px;
}

.response-code {
	background: #f6f8fa;
	border-radius: 6px;
	padding: 16px;
	margin: 0;
	overflow-x: auto;
	max-height: 500px;
	font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Roboto Mono', monospace;
	font-size: 13px;
	line-height: 1.6;
}

.response-code.word-wrap {
	white-space: pre-wrap;
	word-break: break-word;
}

.response-code code {
	font-family: inherit;
}

/* 纯文本 */
.response-content {
	background: #f5f5f5;
	padding: 16px;
	border-radius: 6px;
	white-space: pre-wrap;
	word-break: break-word;
	max-height: 500px;
	overflow-y: auto;
	font-family: monospace;
	font-size: 13px;
	line-height: 1.5;
	margin: 0;
}

/* 媒体容器 */
.media-container {
	text-align: center;
}

.response-media {
	max-width: 100%;
	border-radius: 8px;
	box-shadow: 0 2px 12px rgba(0,0,0,0.1);
}

.response-audio {
	width: 100%;
	max-width: 500px;
}

.streaming-hint {
	color: #67c23a;
	margin-top: 12px;
	font-size: 14px;
}

/* 文件下载 */
.file-container {
	display: flex;
	align-items: center;
	gap: 16px;
	padding: 20px;
	background: #f5f7fa;
	border-radius: 8px;
}

.file-icon {
	font-size: 48px;
}

.file-info {
	display: flex;
	flex-direction: column;
	gap: 8px;
}

.file-name {
	font-weight: 500;
	color: #303133;
}

/* 空状态 */
.empty-state {
	display: grid;
	justify-items: center;
	text-align: center;
	padding: 60px 20px;
	color: #909399;
}

.empty-icon {
	display: grid;
	width: 64px;
	height: 64px;
	margin-bottom: 16px;
	place-items: center;
	color: #8ab8f8;
	font-size: 34px;
	border-radius: 18px;
	background: #eef5ff;
}

.empty-text {
	margin: 7px 0 12px;
	font-size: 13px;
}

.empty-shortcut { padding: 5px 9px; color: #7b8798; font-size: 11px; border: 1px solid #e1e7ef; border-radius: 6px; background: #f8fafc; }

/* 移动端适配 */
@media (max-width: 768px) {
	.response-header {
		flex-direction: column;
		align-items: flex-start;
	}
	
	.response-stats {
		margin-top: 8px;
	}
	
	.code-toolbar {
		flex-wrap: wrap;
	}
	
	.loading-container {
		padding: 40px 16px;
	}
	
	.file-container {
		flex-direction: column;
		text-align: center;
	}
}
</style>
