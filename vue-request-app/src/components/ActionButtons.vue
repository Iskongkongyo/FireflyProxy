<template>
	<section class="action-panel" aria-label="请求编辑与工具">
		<div class="editor-tabs" role="tablist" aria-label="请求配置">
			<button
				v-for="tab in visibleTabs"
				:key="tab.value"
				type="button"
				role="tab"
				class="editor-tab"
				:class="{ active: activeTab === tab.value }"
				:aria-selected="activeTab === tab.value"
				@click="$emit('switch-tab', tab.value)"
			>
				<span aria-hidden="true">{{ tab.icon }}</span>{{ tab.label }}
			</button>
		</div>

		<div class="action-tools">
			<el-dropdown trigger="click">
				<el-button plain>导入与导出<el-icon class="el-icon--right"><ArrowDown /></el-icon></el-button>
				<template #dropdown>
					<el-dropdown-menu>
						<el-dropdown-item @click="$emit('import-curl')">导入 cURL</el-dropdown-item>
						<el-dropdown-item @click="$emit('copy-curl')">复制为 cURL</el-dropdown-item>
						<el-dropdown-item divided @click="$emit('copy-page')">复制请求页面链接</el-dropdown-item>
						<el-dropdown-item @click="$emit('copy-api')">复制直达 API 链接</el-dropdown-item>
					</el-dropdown-menu>
				</template>
			</el-dropdown>

			<el-button v-if="showAddRow" type="primary" plain @click="$emit('add-row')">
				<el-icon><Plus /></el-icon>新增一行
			</el-button>
			<el-button type="success" plain @click="$emit('workspace')">
				<el-icon><FolderOpened /></el-icon>工作区{{ environmentName ? ` · ${environmentName}` : '' }}
			</el-button>
			<el-button v-if="showDownload" type="warning" plain @click="$emit('download')">
				<el-icon><Download /></el-icon>下载响应
			</el-button>
			<el-button plain @click="$emit('history')"><el-icon><Clock /></el-icon>历史</el-button>
		</div>
	</section>
</template>

<script>
export default {
	name: 'ActionButtons',
	props: {
		method: { type: String, default: 'GET' },
		activeTab: { type: String, default: 'params' },
		environmentName: { type: String, default: '' },
		showDownload: { type: Boolean, default: false }
	},
	emits: ['switch-tab', 'add-row', 'workspace', 'import-curl', 'copy-curl', 'copy-page', 'copy-api', 'download', 'history'],
	data() {
		return {
			tabs: [
				{ value: 'params', label: '请求参数', icon: '⌕' },
				{ value: 'headers', label: '请求头', icon: '≡' },
				{ value: 'body', label: '请求体', icon: '{}' },
				{ value: 'auth', label: '身份认证', icon: '◇' },
				{ value: 'redirect', label: '重定向', icon: '↪' }
			]
		};
	},
	computed: {
		showBody() {
			return !['GET', 'HEAD'].includes(this.method.toUpperCase());
		},
		visibleTabs() {
			return this.tabs.filter((tab) => tab.value !== 'body' || this.showBody);
		},
		showAddRow() {
			return ['headers', 'params'].includes(this.activeTab);
		}
	}
};
</script>

<style scoped>
.action-panel {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 14px;
	margin-bottom: 14px;
	padding: 8px;
	border: 1px solid #e3e9f1;
	border-radius: 13px;
	background: rgba(255, 255, 255, 0.92);
	box-shadow: 0 7px 22px rgba(31, 45, 61, 0.04);
}

.editor-tabs,
.action-tools {
	display: flex;
	align-items: center;
	gap: 5px;
}

.editor-tabs { min-width: 0; overflow-x: auto; scrollbar-width: thin; }
.action-tools { justify-content: flex-end; flex-wrap: wrap; }

.editor-tab {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	flex: 0 0 auto;
	min-height: 36px;
	padding: 8px 11px;
	color: #667085;
	font-size: 13px;
	font-weight: 600;
	white-space: nowrap;
	border: 0;
	border-radius: 8px;
	background: transparent;
	cursor: pointer;
}

.editor-tab:hover { color: #1677ff; background: #f3f7fd; }
.editor-tab.active { color: #0958d9; background: #eaf3ff; box-shadow: inset 0 0 0 1px #c4dcff; }
.editor-tab span { color: #1677ff; font-weight: 800; }

.action-tools :deep(.el-button + .el-button) { margin-left: 0; }

@media (max-width: 1040px) {
	.action-panel { align-items: stretch; flex-direction: column; }
	.action-tools { justify-content: flex-start; }
}

@media (max-width: 640px) {
	.action-panel { padding: 7px; }
	.editor-tabs { width: 100%; padding-bottom: 2px; }
	.action-tools { display: grid; grid-template-columns: 1fr 1fr; }
	.action-tools :deep(.el-dropdown),
	.action-tools :deep(.el-button) { width: 100%; margin: 0; }
}
</style>
