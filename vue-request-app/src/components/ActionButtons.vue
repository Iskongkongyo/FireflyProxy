<template>
	<div class="action-buttons">
		<!-- 配置选项卡组 -->
		<div class="tab-group">
			<el-button 
				type="info" 
				:plain="true"
				@click="$emit('switch-tab', 'headers')" 
				class="tab-btn"
				size="default">
				<el-icon class="btn-icon"><List /></el-icon>
				<span class="btn-text">请求头</span>
			</el-button>
			<el-button 
				type="info" 
				:plain="true"
				v-show="showBody" 
				@click="$emit('switch-tab', 'body')" 
				class="tab-btn"
				size="default">
				<el-icon class="btn-icon"><Document /></el-icon>
				<span class="btn-text">请求体</span>
			</el-button>
			<el-button 
				type="info" 
				:plain="true"
				@click="$emit('switch-tab', 'auth')" 
				class="tab-btn"
				size="default">
				<el-icon class="btn-icon"><Lock /></el-icon>
				<span class="btn-text">请求验证</span>
			</el-button>
			<el-button 
				type="info" 
				:plain="true"
				@click="$emit('switch-tab', 'params')" 
				class="tab-btn"
				size="default">
				<el-icon class="btn-icon"><Search /></el-icon>
				<span class="btn-text">请求参数</span>
			</el-button>
		</div>

		<!-- 操作按钮组 -->
		<div class="action-group">
			<el-button type="primary" plain @click="$emit('import-curl')" class="action-btn" size="default">
				<span class="btn-text-full">Import cURL</span>
			</el-button>
			<el-button type="primary" plain @click="$emit('copy-curl')" class="action-btn" size="default">
				<el-icon><CopyDocument /></el-icon>
				<span class="btn-text-full">Copy as cURL</span>
			</el-button>
			<el-button type="success" @click="$emit('add-row')" class="action-btn" size="default">
				<el-icon><Plus /></el-icon>
				<span class="btn-text-full">新增一行</span>
			</el-button>
			<el-button type="primary" @click="$emit('copy-page')" class="action-btn" size="default">
				<el-icon><CopyDocument /></el-icon>
				<span class="btn-text-full">复制页面链接</span>
			</el-button>
			<el-button type="primary" @click="$emit('copy-api')" class="action-btn" size="default">
				<el-icon><Link /></el-icon>
				<span class="btn-text-full">复制API接口</span>
			</el-button>
			<el-button v-if="showDownload" type="warning" @click="$emit('download')" class="action-btn" size="default">
				<el-icon><Download /></el-icon>
				<span class="btn-text-full">下载</span>
			</el-button>
			<el-button type="default" @click="$emit('history')" class="action-btn" size="default">
				<el-icon><Clock /></el-icon>
				<span class="btn-text-full">历史</span>
			</el-button>
		</div>


	</div>
</template>

<script>
import { VideoPlay, Download } from '@element-plus/icons-vue';
import { shallowRef } from 'vue';

export default {
	name: 'ActionButtons',
	props: {
		method: { type: String, default: 'GET' },
		showDownload: { type: Boolean, default: false }
	},
	emits: ['switch-tab', 'add-row', 'import-curl', 'copy-curl', 'copy-page', 'copy-api', 'download', 'history'],
	setup() {
		return {
			VideoPlay: shallowRef(VideoPlay),
			Download: shallowRef(Download)
		};
	},
	computed: {
		showBody() {
			return !['GET', 'HEAD'].includes(this.method.toUpperCase());
		}
	}
};
</script>

<style scoped>
.action-buttons {
	display: flex;
	flex-wrap: wrap;
	gap: 12px;
	align-items: center;
	padding: 12px;
	background: linear-gradient(135deg, #f5f7fa 0%, #e4e7ed 100%);
	border-radius: 12px;
}

/* 选项卡组 */
.tab-group {
	display: flex;
	gap: 4px;
	flex-wrap: wrap;
}

.tab-btn {
	border-radius: 8px !important;
	transition: all 0.2s ease;
}

.tab-btn:hover {
	transform: translateY(-2px);
	box-shadow: 0 4px 12px rgba(0,0,0,0.15);
}

.btn-icon {
	margin-right: 4px;
}

/* 操作按钮组 */
.action-group {
	display: flex;
	gap: 8px;
	flex-wrap: wrap;
	flex: 1;
}

.action-btn {
	border-radius: 8px !important;
	transition: all 0.2s ease;
}

.action-btn:hover {
	transform: translateY(-2px);
	box-shadow: 0 4px 12px rgba(0,0,0,0.15);
}



/* 移动端适配 */
/* 移动端适配 */
@media (max-width: 768px) {
	.action-buttons {
		flex-direction: column;
		align-items: stretch;
		gap: 12px;
		padding: 12px;
	}

	/* 选项卡组 - 垂直排列，每行一个 */
	.tab-group {
		display: flex;
		flex-direction: column;
		gap: 8px;
		width: 100%;
	}

	.tab-btn {
		padding: 12px 16px !important;
		font-size: 14px;
		justify-content: flex-start; /* 图标文字左对齐 */
		height: auto;
	}

	.btn-text {
		display: inline-block; /* 恢复显示文字 */
		margin-left: 8px;
	}

	.btn-icon {
		margin: 0;
		font-size: 16px;
	}

	/* 操作按钮组 - 改为单列垂直排列，解决对齐问题 */
	.action-group {
		display: flex;
		flex-direction: column;
		gap: 8px;
		width: 100%;
	}

	.action-btn {
		padding: 12px 16px !important;
		font-size: 14px;
		justify-content: center; /* 居中对齐 */
		width: 100%;
	}

	/* 在两列布局下隐藏部分长文本，避免溢出 */
	.btn-text-full {
		display: inline-block;
	}

	/* 强制清除 Element UI 默认的相邻按钮左边距，确保垂直排列对齐 */
	:deep(.el-button+.el-button) {
		margin-left: 0; 
	}


}

/* 平板适配 */
@media (min-width: 769px) and (max-width: 1024px) {
	.action-buttons {
		gap: 10px;
	}

	.tab-group, .action-group {
		gap: 6px;
	}
}

/* 大屏优化 */
@media (min-width: 1200px) {
	.action-buttons {
		padding: 16px;
		gap: 16px;
	}
}
</style>
