<template>
	<el-drawer v-model="visible" title="环境与请求集合" size="min(780px, 96vw)" destroy-on-close>
		<el-alert v-if="storageError" :title="storageError" type="error" :closable="false" show-icon />
		<el-tabs v-else v-model="activeTab" v-loading="loading">
			<el-tab-pane label="环境变量" name="environment">
				<div class="toolbar">
					<el-select v-model="activeEnvironmentId" placeholder="不使用环境" clearable
						@change="selectEnvironment" class="grow">
						<el-option v-for="environment in environments" :key="environment.id"
							:label="`${environment.name}${environment.scope === 'session' ? '（当前会话）' : ''}`"
							:value="environment.id" />
					</el-select>
					<el-button @click="newEnvironment">新建环境</el-button>
				</div>

				<el-alert
					title="环境变量会在发送前替换 URL、请求参数、请求头、请求体与认证中的 {{name}}；它不是脚本表达式。"
					type="info" :closable="false" show-icon />

				<div v-if="environmentDraft" class="editor-section">
					<el-form label-width="110px">
						<el-form-item label="环境名称">
							<el-input v-model="environmentDraft.name" maxlength="80" show-word-limit
								placeholder="例如 Development" />
						</el-form-item>
						<el-form-item label="存储范围">
							<el-radio-group v-model="environmentDraft.scope">
								<el-radio-button label="persistent">IndexedDB 持久化</el-radio-button>
								<el-radio-button label="session">仅本标签会话</el-radio-button>
							</el-radio-group>
						</el-form-item>
					</el-form>

					<el-alert v-if="environmentDraft.scope === 'persistent'"
						title="持久化变量未加密，同源脚本、浏览器扩展及可访问本机浏览器资料的人可能读取；敏感标记只负责遮罩和风险提示。"
						type="warning" :closable="false" show-icon />
					<el-alert v-else
						title="会话环境保存在 sessionStorage，通常随当前标签页会话结束而清除，但仍可被同源脚本读取。"
						type="warning" :closable="false" show-icon />

					<div class="section-heading">
						<span>变量</span>
						<el-button type="primary" plain @click="addVariable">新增变量</el-button>
					</div>
					<el-table :data="environmentDraft.variables" border size="small">
						<el-table-column label="启用" width="70" align="center">
							<template #default="{ row }"><el-switch v-model="row.enabled" /></template>
						</el-table-column>
						<el-table-column label="变量名" min-width="150">
							<template #default="{ row }"><el-input v-model="row.key" placeholder="baseUrl" /></template>
						</el-table-column>
						<el-table-column label="变量值" min-width="240">
							<template #default="{ row }">
								<el-input v-model="row.value" :type="row.secret ? 'password' : 'text'"
									:show-password="row.secret" placeholder="变量值或 {{other}}" />
							</template>
						</el-table-column>
						<el-table-column label="敏感" width="76" align="center">
							<template #default="{ row }"><el-switch v-model="row.secret" /></template>
						</el-table-column>
						<el-table-column label="操作" width="82" align="center">
							<template #default="{ $index }">
								<el-button type="danger" link @click="removeVariable($index)">删除</el-button>
							</template>
						</el-table-column>
					</el-table>
					<div class="footer-actions">
						<el-button v-if="environmentExists" type="danger" plain @click="deleteEnvironment">删除环境</el-button>
						<el-button type="primary" @click="saveEnvironment">保存并启用</el-button>
					</div>
				</div>
				<el-empty v-else description="当前未选择环境；可直接发送不含变量的请求。" />
			</el-tab-pane>

			<el-tab-pane label="请求集合" name="collections">
				<el-alert
					title="请求集合仅保存在当前站点的 IndexedDB，不加密、不上传、不同浏览器或设备之间不会同步。"
					type="warning" :closable="false" show-icon />

				<div class="editor-section">
					<div class="section-heading"><span>文件夹</span></div>
					<div class="toolbar">
						<el-input v-model="newFolderName" maxlength="80" placeholder="新文件夹名称" class="grow" />
						<el-button type="primary" plain @click="createFolder">新增文件夹</el-button>
					</div>
					<div v-if="folders.length" class="folder-tags">
						<el-tag v-for="folder in folders" :key="folder.id" closable
							@close="deleteFolder(folder)">{{ folder.name }}</el-tag>
					</div>

					<div class="section-heading"><span>保存当前请求</span></div>
					<div class="save-grid">
						<el-input v-model="requestName" maxlength="80" placeholder="请求名称" />
						<el-select v-model="requestFolderId" clearable placeholder="未分类">
							<el-option v-for="folder in folders" :key="folder.id" :label="folder.name" :value="folder.id" />
						</el-select>
						<el-button type="primary" @click="saveCurrentRequest">保存</el-button>
					</div>

					<div class="section-heading"><span>已保存请求</span></div>
					<el-table :data="sortedRequests" border size="small" empty-text="尚无已保存请求">
						<el-table-column prop="method" label="请求方法" width="86" />
						<el-table-column prop="name" label="名称" min-width="150" />
						<el-table-column label="文件夹" min-width="110">
							<template #default="{ row }">{{ folderName(row.folderId) }}</template>
						</el-table-column>
						<el-table-column prop="url" label="URL" min-width="240" show-overflow-tooltip />
						<el-table-column label="操作" width="184" fixed="right">
							<template #default="{ row }">
								<el-button type="primary" link @click="loadRequest(row)">加载</el-button>
								<el-button type="warning" link @click="overwriteRequest(row)">覆盖</el-button>
								<el-button type="danger" link @click="deleteRequest(row)">删除</el-button>
							</template>
						</el-table-column>
					</el-table>
				</div>
			</el-tab-pane>
		</el-tabs>
	</el-drawer>
</template>

<script>
	import { ElMessage, ElMessageBox } from 'element-plus';
	import { createWorkspaceStore } from '../utils/workspaceStorage.mjs';
	import {
		createVariable,
		createWorkspaceId,
		normalizeEnvironment,
		normalizeSavedRequest,
		requestContainsStoredSecrets,
		requestUsesSecretVariables
	} from '../utils/workspaceModel.mjs';

	function clone(value) {
		return JSON.parse(JSON.stringify(value));
	}

	export default {
		name: 'WorkspacePanel',
		emits: ['load-request', 'environment-change'],
		data() {
			return {
				store: null,
				visible: false,
				loading: false,
				storageError: '',
				activeTab: 'environment',
				environments: [],
				activeEnvironmentId: '',
				environmentDraft: null,
				folders: [],
				requests: [],
				currentDraft: null,
				newFolderName: '',
				requestName: '',
				requestFolderId: ''
			};
		},
		computed: {
			environmentExists() {
				return this.environments.some(environment => environment.id === this.environmentDraft?.id);
			},
			activeEnvironment() {
				return this.environments.find(environment => environment.id === this.activeEnvironmentId) || null;
			},
			sortedRequests() {
				return [...this.requests].sort((a, b) => {
					const folder = this.folderName(a.folderId).localeCompare(this.folderName(b.folderId));
					return folder || a.name.localeCompare(b.name);
				});
			}
		},
		async mounted() {
			this.store = createWorkspaceStore();
			await this.refresh();
		},
		methods: {
			async run(action) {
				this.loading = true;
				try {
					return await action();
				} catch (error) {
					this.storageError = error.message || '工作区存储不可用。';
					ElMessage.error(this.storageError);
					return undefined;
				} finally {
					this.loading = false;
				}
			},
			async refresh() {
				await this.run(async () => {
					const [environments, folders, requests, activeId] = await Promise.all([
						this.store.listEnvironments(), this.store.listFolders(), this.store.listRequests(),
						this.store.getActiveEnvironmentId()
					]);
					this.environments = environments;
					this.folders = folders;
					this.requests = requests;
					this.activeEnvironmentId = environments.some(item => item.id === activeId) ? activeId : '';
					this.environmentDraft = this.activeEnvironment ? clone(this.activeEnvironment) : null;
					this.$emit('environment-change', this.activeEnvironment ? clone(this.activeEnvironment) : null);
				});
			},
			open(currentDraft) {
				this.currentDraft = currentDraft;
				this.visible = true;
			},
			async selectEnvironment(id) {
				this.activeEnvironmentId = id || '';
				this.environmentDraft = this.activeEnvironment ? clone(this.activeEnvironment) : null;
				await this.store.setActiveEnvironmentId(this.activeEnvironmentId);
				this.$emit('environment-change', this.activeEnvironment ? clone(this.activeEnvironment) : null);
			},
			newEnvironment() {
				this.environmentDraft = {
					id: createWorkspaceId('env'), name: '', scope: 'session', variables: [createVariable()]
				};
			},
			addVariable() {
				this.environmentDraft.variables.push(createVariable());
			},
			removeVariable(index) {
				this.environmentDraft.variables.splice(index, 1);
			},
			async saveEnvironment() {
				try {
					const environment = normalizeEnvironment(this.environmentDraft);
					if (environment.scope === 'persistent' && environment.variables.some(row => row.secret)) {
						await ElMessageBox.confirm(
							'敏感变量将以未加密形式持久化到当前站点 IndexedDB。敏感标记不会提供加密，是否继续？',
							'持久化敏感变量风险',
							{ type: 'warning', confirmButtonText: '理解风险并保存', cancelButtonText: '取消' }
						);
					}
					const saved = await this.store.putEnvironment(environment);
					await this.store.setActiveEnvironmentId(saved.id);
					await this.refresh();
					ElMessage.success('环境已保存并启用。');
				} catch (error) {
					if (error === 'cancel' || error === 'close') return;
					ElMessage.error(error.message || String(error));
				}
			},
			async deleteEnvironment() {
				try {
					await ElMessageBox.confirm('删除后无法恢复该环境，是否继续？', '删除环境', { type: 'warning' });
					await this.store.deleteEnvironment(this.environmentDraft.id);
					await this.store.setActiveEnvironmentId('');
					await this.refresh();
				} catch (error) {
					if (error !== 'cancel' && error !== 'close') ElMessage.error(error.message || String(error));
				}
			},
			async createFolder() {
				try {
					await this.store.putFolder({ name: this.newFolderName });
					this.newFolderName = '';
					this.folders = await this.store.listFolders();
				} catch (error) { ElMessage.error(error.message || String(error)); }
			},
			async deleteFolder(folder) {
				try {
					await ElMessageBox.confirm('文件夹删除后，其中的请求会移动到“未分类”。', '删除文件夹', { type: 'warning' });
					await this.store.deleteFolder(folder.id);
					this.folders = await this.store.listFolders();
					this.requests = await this.store.listRequests();
				} catch (error) {
					if (error !== 'cancel' && error !== 'close') ElMessage.error(error.message || String(error));
				}
			},
			folderName(id) {
				return this.folders.find(folder => folder.id === id)?.name || '未分类';
			},
			async confirmRequestStorage(request) {
				if (!requestContainsStoredSecrets(request)
					&& !requestUsesSecretVariables(request, this.activeEnvironment)) return;
				await ElMessageBox.confirm(
							'该请求包含认证信息、敏感请求头或 Secret 环境变量引用。请求集合未加密且会持久化到 IndexedDB，是否继续？',
					'敏感请求提醒',
					{ type: 'warning', confirmButtonText: '理解风险并保存', cancelButtonText: '取消' }
				);
			},
			async persistRequest(value) {
				const request = normalizeSavedRequest(value);
				await this.confirmRequestStorage(request);
				await this.store.putRequest(request);
				this.requests = await this.store.listRequests();
				return request;
			},
			async saveCurrentRequest() {
				try {
					if (!this.currentDraft) throw new Error('没有可保存的当前请求。');
					await this.persistRequest({
						...this.currentDraft,
						name: this.requestName,
						folderId: this.requestFolderId || null
					});
					this.requestName = '';
					ElMessage.success('当前请求已保存。');
				} catch (error) {
					if (error !== 'cancel' && error !== 'close') ElMessage.error(error.message || String(error));
				}
			},
			loadRequest(request) {
				this.$emit('load-request', clone(request));
				this.visible = false;
				const missingFile = request.body?.type === 'multipart'
					&& request.body.rows.some(row => row.kind === 'file');
				ElMessage.success(missingFile
					? '请求已加载；multipart 文件必须重新选择。'
						: '请求已加载。');
			},
			async overwriteRequest(request) {
				try {
					await ElMessageBox.confirm(`使用当前编辑器覆盖“${request.name}”？`, '覆盖已保存请求', { type: 'warning' });
					await this.persistRequest({
						...this.currentDraft,
						id: request.id,
						name: request.name,
						folderId: request.folderId,
						createdAt: request.createdAt
					});
					ElMessage.success('已保存请求已覆盖。');
				} catch (error) {
					if (error !== 'cancel' && error !== 'close') ElMessage.error(error.message || String(error));
				}
			},
			async deleteRequest(request) {
				try {
					await ElMessageBox.confirm(`删除“${request.name}”？`, '删除已保存请求', { type: 'warning' });
					await this.store.deleteRequest(request.id);
					this.requests = await this.store.listRequests();
				} catch (error) {
					if (error !== 'cancel' && error !== 'close') ElMessage.error(error.message || String(error));
				}
			}
		}
	};
</script>

<style scoped>
	.toolbar, .section-heading, .footer-actions, .folder-tags { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
	.toolbar { margin-bottom: 14px; }
	.grow { flex: 1; min-width: 220px; }
	.editor-section { display: grid; gap: 14px; margin-top: 16px; }
	.section-heading { justify-content: space-between; font-weight: 600; margin-top: 8px; }
	.footer-actions { justify-content: flex-end; }
	.folder-tags { min-height: 28px; }
	.save-grid { display: grid; grid-template-columns: minmax(180px, 1fr) minmax(150px, 220px) auto; gap: 10px; }
	@media (max-width: 700px) {
		.save-grid { grid-template-columns: 1fr; }
	}
</style>
