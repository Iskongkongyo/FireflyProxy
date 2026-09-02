<template>
	<main class="history-page">
		<ModeSwitcher />

		<header class="page-hero">
			<div>
				<span class="eyebrow">REQUEST ARCHIVE</span>
				<h1>请求历史</h1>
				<p>查找、复制或重新打开保存过的请求页面。历史记录仅保存在当前浏览器中。</p>
			</div>
			<div class="history-summary" aria-label="历史记录数量">
				<strong>{{ history.length }}</strong>
				<span>条本地记录</span>
			</div>
		</header>

		<el-card class="history-card" shadow="never">
			<div class="history-toolbar">
				<div class="search-box">
					<el-input
						v-model="searchQuery"
						clearable
						placeholder="搜索目标地址、页面链接或时间"
						aria-label="搜索请求历史"
						@input="currentPage = 1"
					>
						<template #prefix><el-icon><Search /></el-icon></template>
					</el-input>
					<span v-if="searchQuery" class="filter-result">找到 {{ filteredHistory.length }} 条</span>
				</div>
				<div class="toolbar-actions">
					<el-button
						class="selection-action"
						type="danger"
						plain
						:disabled="multipleSelection.length === 0"
						@click="handleDelete"
					>
						删除选中{{ multipleSelection.length ? `（${multipleSelection.length}）` : '' }}
					</el-button>
					<el-button type="danger" text :disabled="history.length === 0" @click="handleDeleteAll">
						清空全部
					</el-button>
				</div>
			</div>

			<el-table
				ref="historyTable"
				:data="paginatedData"
				class="history-table"
				@selection-change="handleSelectionChange"
			>
				<el-table-column type="selection" width="48" />
				<el-table-column label="保存时间" min-width="160" sortable :sort-method="sortByDate">
					<template #default="scope">
						<div class="date-cell">
							<strong>{{ formatDate(scope.row.date) }}</strong>
							<span>{{ scope.row.date || '时间未知' }}</span>
						</div>
					</template>
				</el-table-column>
				<el-table-column label="请求页面" min-width="270">
					<template #default="scope">
						<div class="url-cell">
							<el-tag size="small" type="info" effect="plain">{{ requestMethod(scope.row.url) }}</el-tag>
							<div>
								<strong>{{ targetSummary(scope.row.url) }}</strong>
								<span>{{ scope.row.url }}</span>
							</div>
						</div>
					</template>
				</el-table-column>
				<el-table-column label="操作" width="224" align="center" fixed="right">
					<template #default="scope">
						<div class="table-actions">
							<el-button type="primary" plain @click="copyUrl(scope.row.url)">
								<el-icon><CopyDocument /></el-icon>复制
							</el-button>
							<el-button type="primary" @click="jumpUrl(scope.row.url)">
								重新打开<el-icon class="el-icon--right"><TopRight /></el-icon>
							</el-button>
						</div>
					</template>
				</el-table-column>
				<template #empty>
					<div class="empty-state">
						<div class="empty-icon">◷</div>
						<strong>{{ searchQuery ? '没有匹配的历史记录' : '还没有请求历史' }}</strong>
						<p>{{ searchQuery ? '尝试缩短关键词或清空搜索条件。' : '在 API 请求页复制页面链接后，记录会显示在这里。' }}</p>
						<el-button v-if="!searchQuery" type="primary" @click="goToHome">前往 API 请求</el-button>
					</div>
				</template>
			</el-table>

			<div class="mobile-history-list">
				<article v-for="record in paginatedData" :key="`${record.date}-${record.url}`" class="history-record">
					<div class="record-heading">
						<el-tag size="small" type="info" effect="plain">{{ requestMethod(record.url) }}</el-tag>
						<span>{{ formatDate(record.date) }}</span>
					</div>
					<strong>{{ targetSummary(record.url) }}</strong>
					<p>{{ record.url }}</p>
					<div class="record-actions">
						<el-button plain @click="copyUrl(record.url)"><el-icon><CopyDocument /></el-icon>复制链接</el-button>
						<el-button type="primary" @click="jumpUrl(record.url)">重新打开<el-icon class="el-icon--right"><TopRight /></el-icon></el-button>
					</div>
				</article>

				<div v-if="!paginatedData.length" class="mobile-empty">
					<div class="empty-icon">◷</div>
					<strong>{{ searchQuery ? '没有匹配的历史记录' : '还没有请求历史' }}</strong>
					<p>{{ searchQuery ? '尝试缩短关键词或清空搜索条件。' : '复制 API 请求页面链接后，记录会显示在这里。' }}</p>
					<el-button v-if="!searchQuery" type="primary" @click="goToHome">前往 API 请求</el-button>
				</div>
			</div>

			<div v-if="filteredHistory.length" class="pagination-shell">
				<span>记录保存在浏览器 LocalStorage，清理站点数据后会消失。</span>
				<el-pagination
					background
					:current-page="currentPage"
					:page-size="pageSize"
					:page-sizes="[5, 10, 20]"
					layout="total, sizes, prev, pager, next"
					:total="filteredHistory.length"
					@size-change="handleSizeChange"
					@current-change="handleCurrentChange"
				/>
			</div>
		</el-card>
	</main>
</template>

<script>
import { ElMessage, ElMessageBox } from 'element-plus';
import { CopyDocument, Search, TopRight } from '@element-plus/icons-vue';
import ModeSwitcher from './ModeSwitcher.vue';

export default {
	name: 'HistoryRecord',
	components: { CopyDocument, ModeSwitcher, Search, TopRight },
	data() {
		return {
			history: [],
			multipleSelection: [],
			searchQuery: '',
			currentPage: 1,
			pageSize: 10
		};
	},
	computed: {
		filteredHistory() {
			const keyword = this.searchQuery.trim().toLowerCase();
			if (!keyword) return this.history;
			return this.history.filter((record) => {
				const haystack = [record.date, record.url, this.targetSummary(record.url), this.requestMethod(record.url)]
					.join(' ')
					.toLowerCase();
				return haystack.includes(keyword);
			});
		},
		paginatedData() {
			const start = (this.currentPage - 1) * this.pageSize;
			return this.filteredHistory.slice(start, start + this.pageSize);
		}
	},
	mounted() {
		this.$emit('update-message', true);
		this.historyRecords();
	},
	methods: {
		goToHome() {
			this.$router.push('/');
		},
		historyRecords() {
			try {
				const records = JSON.parse(localStorage.getItem('history') || '[]');
				if (!Array.isArray(records)) throw new TypeError('历史记录不是数组');
				this.history = records
					.filter((record) => record && typeof record.url === 'string')
					.map((record) => ({ date: String(record.date || ''), url: record.url }))
					.sort((a, b) => new Date(b.date) - new Date(a.date));
			} catch {
				this.history = [];
				ElMessage.warning('本地历史记录格式异常，已忽略损坏的数据。');
			}
			this.normalizePage();
		},
		requestUrl(value) {
			try {
				return new URL(value, window.location.origin);
			} catch {
				return null;
			}
		},
		targetSummary(value) {
			const pageUrl = this.requestUrl(value);
			const target = pageUrl?.searchParams.get('url');
			if (!target) return pageUrl?.hostname || '请求页面';
			try {
				const targetUrl = new URL(target);
				return `${targetUrl.hostname}${targetUrl.pathname === '/' ? '' : targetUrl.pathname}`;
			} catch {
				return target;
			}
		},
		requestMethod(value) {
			return (this.requestUrl(value)?.searchParams.get('method') || 'GET').toUpperCase();
		},
		formatDate(value) {
			const date = new Date(value);
			if (Number.isNaN(date.getTime())) return '时间未知';
			return new Intl.DateTimeFormat('zh-CN', {
				month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
			}).format(date);
		},
		sortByDate(a, b) {
			return new Date(a.date) - new Date(b.date);
		},
		handleSelectionChange(value) {
			this.multipleSelection = value;
		},
		normalizePage() {
			const pageCount = Math.max(1, Math.ceil(this.filteredHistory.length / this.pageSize));
			this.currentPage = Math.min(this.currentPage, pageCount);
		},
		async handleDeleteAll() {
			try {
				await ElMessageBox.confirm('此操作会删除当前浏览器中的全部请求历史，且无法恢复。', '清空请求历史', {
					confirmButtonText: '确认清空', cancelButtonText: '取消', type: 'warning'
				});
				localStorage.removeItem('history');
				this.history = [];
				this.multipleSelection = [];
				this.currentPage = 1;
				ElMessage.success('请求历史已清空。');
			} catch (error) {
				if (error !== 'cancel' && error !== 'close') ElMessage.error('清空失败，请稍后重试。');
			}
		},
		async handleDelete() {
			if (!this.multipleSelection.length) return;
			try {
				await ElMessageBox.confirm(`确认删除选中的 ${this.multipleSelection.length} 条记录？`, '删除请求历史', {
					confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning'
				});
				this.history = this.history.filter((item) => !this.multipleSelection.includes(item));
				localStorage.setItem('history', JSON.stringify(this.history));
				this.multipleSelection = [];
				this.$refs.historyTable?.clearSelection();
				this.normalizePage();
				ElMessage.success('选中的记录已删除。');
			} catch (error) {
				if (error !== 'cancel' && error !== 'close') ElMessage.error('删除失败，请稍后重试。');
			}
		},
		handleSizeChange(value) {
			this.pageSize = value;
			this.currentPage = 1;
		},
		handleCurrentChange(value) {
			this.currentPage = value;
		},
		async copyUrl(url) {
			try {
				await navigator.clipboard.writeText(url);
				ElMessage.success('页面链接已复制。');
			} catch {
				ElMessage.error('复制失败，请检查剪贴板权限。');
			}
		},
		jumpUrl(value) {
			const url = this.requestUrl(value);
			if (!url || !['http:', 'https:'].includes(url.protocol)) {
				ElMessage.error('该历史链接无效，无法打开。');
				return;
			}
			window.open(url.href, '_blank', 'noopener,noreferrer');
		}
	}
};
</script>

<style scoped>
.history-page {
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
	margin: 0 0 18px;
	padding: 18px 4px 4px;
	text-align: left;
}

.eyebrow {
	color: #1677ff;
	font-size: 11px;
	font-weight: 800;
	letter-spacing: 0.16em;
}

h1 { margin: 6px 0 7px; font-size: clamp(28px, 4vw, 38px); letter-spacing: -0.04em; }
.page-hero p { max-width: 680px; margin: 0; color: #667085; line-height: 1.7; }

.history-summary {
	display: grid;
	min-width: 126px;
	padding: 14px 18px;
	text-align: right;
	border: 1px solid #dce9fa;
	border-radius: 13px;
	background: #f7fbff;
}

.history-summary strong { color: #1677ff; font-size: 25px; }
.history-summary span { color: #7b8798; font-size: 12px; }

.history-card { border-color: #e4eaf2; border-radius: 15px; text-align: left; }

.history-toolbar,
.pagination-shell {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 16px;
}

.history-toolbar { margin-bottom: 16px; }
.search-box { display: flex; align-items: center; gap: 12px; width: min(520px, 100%); }
.filter-result { flex: 0 0 auto; color: #7b8798; font-size: 12px; }
.toolbar-actions { display: flex; align-items: center; }
.history-table { width: 100%; border-top: 1px solid #edf0f5; }
.mobile-history-list { display: none; }
.table-actions { display: flex; align-items: center; justify-content: center; gap: 8px; white-space: nowrap; }
.table-actions :deep(.el-button) { margin: 0; }

.date-cell,
.url-cell > div { display: grid; min-width: 0; gap: 4px; }
.date-cell strong { font-size: 13px; }
.date-cell span,
.url-cell span { overflow: hidden; color: #8a94a6; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }

.url-cell { display: flex; align-items: flex-start; gap: 10px; min-width: 0; }
.url-cell > div { flex: 1; }
.url-cell strong { overflow: hidden; font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }

.empty-state { display: grid; justify-items: center; padding: 48px 16px; color: #7b8798; }
.empty-icon { margin-bottom: 8px; color: #b4c1d3; font-size: 48px; }
.empty-state strong { color: #344054; font-size: 16px; }
.empty-state p { margin: 8px 0 18px; }

.pagination-shell { padding-top: 18px; }
.pagination-shell > span { color: #98a2b3; font-size: 12px; }

@media (max-width: 760px) {
	.history-page { width: min(100% - 24px, 1180px); padding-top: 12px; }
	.page-hero { align-items: flex-start; flex-direction: column; gap: 14px; padding-top: 10px; }
	.history-summary { width: 100%; text-align: left; }
	.history-toolbar,
	.pagination-shell { align-items: stretch; flex-direction: column; }
	.search-box { align-items: flex-start; flex-direction: column; }
	.toolbar-actions { justify-content: space-between; }
	.pagination-shell :deep(.el-pagination) { justify-content: center; overflow-x: auto; }
	.pagination-shell > span { text-align: center; }
	.history-card :deep(.el-card__body) { padding: 14px; }
}

@media (max-width: 650px) {
	.history-table,
	.selection-action { display: none; }
	.mobile-history-list { display: grid; gap: 12px; padding-top: 14px; border-top: 1px solid #edf0f5; }
	.history-record { min-width: 0; padding: 14px; border: 1px solid #e4eaf2; border-radius: 12px; background: #f9fbfe; }
	.record-heading { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 11px; }
	.record-heading span { color: #7b8798; font-size: 12px; }
	.history-record > strong { display: block; overflow: hidden; font-size: 14px; text-overflow: ellipsis; white-space: nowrap; }
	.history-record > p { overflow: hidden; margin: 6px 0 13px; color: #8a94a6; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
	.record-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
	.record-actions :deep(.el-button) { width: 100%; margin: 0; }
	.mobile-empty { display: grid; justify-items: center; padding: 42px 10px; text-align: center; color: #7b8798; }
	.mobile-empty strong { color: #344054; }
	.mobile-empty p { margin: 8px 0 18px; font-size: 13px; line-height: 1.65; }
}
</style>
