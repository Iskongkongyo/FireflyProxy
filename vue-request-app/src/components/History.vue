<template>
	<el-container>
		<el-header style="color:#409EFF;font-size: 40px" height="45px">
			<el-row>
				<el-col :span="24">
					请求历史记录
				</el-col>
			</el-row>
		</el-header>
		<el-main>

			<div>

				<div class="operation-container">
					<el-button type="primary" @click="goToHome">
						返回主页
					</el-button>

					<el-button type="danger" :disabled="multipleSelection.length === 0" @click="handleDelete">
						删除选中项
					</el-button>

					<el-button type="danger" @click="handleDeleteAll">
						清空所有
					</el-button>

				</div>
				<el-table :data="paginatedData" style="width: 100%" @selection-change="handleSelectionChange" border
					stripe>
					<el-table-column type="selection" width="55" />
					<el-table-column prop="date" label="时间" width="180" sortable />
					<el-table-column prop="url" label="请求的URL" show-overflow-tooltip />
					<el-table-column label="操作" width="160" fixed="right">
						<template #default="scope">
							<el-button type="primary" size="small" @click="copyUrl(scope.row.url)">
								<el-icon><CopyDocument /></el-icon> 复制
							</el-button>
							<el-button type="success" size="small" @click="jumpUrl(scope.row.url)">
								<el-icon><TopRight /></el-icon> 跳转
							</el-button>
						</template>
					</el-table-column>
				</el-table>

				<el-pagination class="pagination" background :current-page="currentPage" :page-size="pageSize"
					:page-sizes="[5, 10, 20]" layout="total, sizes, prev, pager, next, jumper" :total="history.length"
					@size-change="handleSizeChange" @current-change="handleCurrentChange" />

			</div>

			<el-backtop :right="100" :bottom="100" />

		</el-main>
	</el-container>

</template>

<script>
	import {
		ElMessage,
		ElMessageBox
	} from 'element-plus';
	import { CopyDocument, TopRight } from '@element-plus/icons-vue';

	export default {
		name: 'HistoryRecord',
		components: {
			CopyDocument,
			TopRight
		},
		data() {
			return {
				history: [],
				multipleSelection: [],
				currentPage: 1,
				pageSize: 10
			}
		},
		computed: {
			paginatedData() {
				const start = (this.currentPage - 1) * this.pageSize
				const end = start + this.pageSize
				return this.history.slice(start, end)
			}
		},
		mounted() {
			this.historyRecords();
		},
		methods: {
			goToHome() {
				this.$router.push('/');
			},
			historyRecords() {
				const records = JSON.parse(localStorage.getItem('history') || "[]");
				this.history = records.sort((a, b) => new Date(b.date) - new Date(a.date));
			},
			handleSelectionChange(val) {
				this.multipleSelection = val;
			},
			handleDeleteAll() {
				ElMessageBox.confirm(
						'是否删除所有请求历史记录？',
						'温馨提示', {
							confirmButtonText: '删除',
							cancelButtonText: '取消',
							type: 'warning',
						}
					)
					.then(() => {
						localStorage.removeItem('history');
						// 更新数据
						this.historyRecords();
						// 重置页码
						if (this.currentPage > Math.ceil(this.history.length / this.pageSize)) {
							this.currentPage = Math.max(1, this.currentPage - 1);
						}
						ElMessage.success('已清空所有历史记录');
					})
					.catch(() => {
						ElMessage.info('已取消删除');
					});
			},
			handleDelete() {
				// 获取要保留的记录
				const remaining = this.history.filter(
					item => !this.multipleSelection.includes(item)
				);

				ElMessageBox.confirm(
						`是否删除选中的 ${this.multipleSelection.length} 条记录？`,
						'温馨提示', {
							confirmButtonText: '删除',
							cancelButtonText: '取消',
							type: 'warning',
						}
					)
					.then(() => {
						// 更新本地存储
						localStorage.setItem('history', JSON.stringify(remaining));
						// 更新数据
						this.history = remaining;
						this.multipleSelection = [];
						// 重置页码
						if (this.currentPage > Math.ceil(this.history.length / this.pageSize)) {
							this.currentPage = Math.max(1, this.currentPage - 1);
						}
						ElMessage.success('删除成功');
					})
					.catch(() => {
						ElMessage.info('已取消删除');
					});
			},
			handleSizeChange(val) {
				this.pageSize = val;
				this.currentPage = 1;
			},
			handleCurrentChange(val) {
				this.currentPage = val;
			},
			async copyUrl(url) {
				try {
					await navigator.clipboard.writeText(url);
					ElMessage.success('URL 已复制到剪贴板');
				} catch (err) {
					ElMessage.error('复制失败');
				}
			},
			jumpUrl(url) {
				window.open(url, '_blank');
			}
		}
	}
</script>

<style scoped>
	.operation-container {
		margin-bottom: 20px;
		text-align: right;
	}

	.pagination {
		margin-top: 20px;
		justify-content: flex-end;
	}

	.el-table {
		margin-top: 20px;
	}
</style>