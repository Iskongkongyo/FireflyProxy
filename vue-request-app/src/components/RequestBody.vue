<template>
	<div class="request-body">
		<div class="body-toolbar">
			<el-radio-group v-model="state.mode">
				<el-radio-button label="none">none</el-radio-button>
				<el-radio-button label="raw">Raw</el-radio-button>
				<el-radio-button label="json">JSON</el-radio-button>
				<el-radio-button label="urlencoded">x-www-form-urlencoded</el-radio-button>
				<el-radio-button label="multipart">multipart/form-data</el-radio-button>
			</el-radio-group>
			<div class="body-actions">
				<el-button v-if="showsRows" type="primary" @click="addRow">新增字段</el-button>
				<el-button type="warning" plain @click="resetAll">重置</el-button>
			</div>
		</div>

		<el-empty v-if="state.mode === 'none'" description="当前请求不发送 Body" :image-size="72" />

		<div v-else-if="state.mode === 'raw'" class="body-editor">
			<el-input v-model="rawContentType" placeholder="Content-Type，例如 text/plain;charset=utf-8">
				<template #prepend>Content-Type</template>
			</el-input>
			<el-input v-model="rawText" type="textarea" :rows="9" placeholder="输入原始请求体" />
		</div>

		<div v-else-if="state.mode === 'json'" class="body-editor">
			<el-input v-model="jsonText" type="textarea" :rows="10"
				placeholder='输入合法 JSON，例如 {"name":"proxyWeb"}' />
			<div class="json-actions">
				<el-button @click="formatJson">格式化</el-button>
				<el-button @click="jsonText = ''">清空</el-button>
				<el-tag v-if="jsonText" :type="jsonValid ? 'success' : 'danger'">
					{{ jsonValid ? 'JSON 合法' : 'JSON 非法' }}
				</el-tag>
			</div>
		</div>

		<el-table v-else-if="state.mode === 'urlencoded'" :data="urlencodedRows" border size="small">
			<el-table-column label="启用" width="76" align="center">
				<template #default="{ row }"><el-switch v-model="row.enabled" /></template>
			</el-table-column>
			<el-table-column label="Key" min-width="180">
				<template #default="{ row }"><el-input v-model="row.key" placeholder="字段名" /></template>
			</el-table-column>
			<el-table-column label="Value" min-width="260">
				<template #default="{ row }"><el-input v-model="row.value" placeholder="字段值" /></template>
			</el-table-column>
			<el-table-column label="操作" width="96" align="center">
				<template #default="{ $index }">
					<el-button type="danger" plain @click="removeRow($index)">删除</el-button>
				</template>
			</el-table-column>
		</el-table>

		<div v-else class="multipart-editor">
			<el-alert title="浏览器不会从 cURL 路径自动读取文件；导入后请重新选择本地文件。"
				type="info" :closable="false" show-icon />
			<el-table :data="multipartRows" border size="small">
				<el-table-column label="启用" width="76" align="center">
					<template #default="{ row }"><el-switch v-model="row.enabled" /></template>
				</el-table-column>
				<el-table-column label="Key" min-width="160">
					<template #default="{ row }"><el-input v-model="row.key" placeholder="字段名" /></template>
				</el-table-column>
				<el-table-column label="类型" width="110">
					<template #default="{ row }">
						<el-select v-model="row.kind" @change="clearMultipartValue(row)">
							<el-option label="Text" value="text" />
							<el-option label="File" value="file" />
						</el-select>
					</template>
				</el-table-column>
				<el-table-column label="Value / File" min-width="300">
					<template #default="{ row }">
						<el-input v-if="row.kind === 'text'" v-model="row.value" placeholder="字段值" />
						<div v-else class="file-picker">
							<label class="file-button">
								选择文件
								<input type="file" @change="selectFile(row, $event)" />
							</label>
							<span :class="{ 'missing-file': !row.file }">
								{{ row.file ? `${row.file.name} (${formatBytes(row.file.size)})` : (row.fileName || '尚未选择') }}
							</span>
						</div>
					</template>
				</el-table-column>
				<el-table-column label="操作" width="96" align="center">
					<template #default="{ $index }">
						<el-button type="danger" plain @click="removeRow($index)">删除</el-button>
					</template>
				</el-table-column>
			</el-table>
		</div>
	</div>
</template>

<script>
	import { ElMessage } from 'element-plus';
	import { createEditorRow, normalizeEditorRows } from '../utils/requestEditor.mjs';
	import { buildRequestBody } from '../utils/requestBody.mjs';

	function createMultipartRow(overrides = {}) {
		return {
			enabled: overrides.enabled !== false,
			key: String(overrides.key ?? ''),
			kind: overrides.kind === 'file' ? 'file' : 'text',
			value: String(overrides.value ?? ''),
			file: overrides.file || null,
			fileName: String(overrides.fileName ?? ''),
			filePath: String(overrides.filePath ?? '')
		};
	}

	export default {
		name: 'RequestBody',
		emits: ['submit-payload'],
		data() {
			return {
				state: { mode: 'none' },
				rawText: '',
				rawContentType: 'text/plain;charset=utf-8',
				jsonText: '',
				urlencodedRows: [createEditorRow()],
				multipartRows: [createMultipartRow()]
			};
		},
		computed: {
			showsRows() {
				return ['urlencoded', 'multipart'].includes(this.state.mode);
			},
			jsonValid() {
				if (!this.jsonText) return false;
				try {
					JSON.parse(this.jsonText);
					return true;
				} catch {
					return false;
				}
			}
		},
		methods: {
			addRow() {
				if (this.state.mode === 'multipart') this.multipartRows.push(createMultipartRow());
				else if (this.state.mode === 'urlencoded') this.urlencodedRows.push(createEditorRow());
			},
			removeRow(index) {
				const rows = this.state.mode === 'multipart' ? this.multipartRows : this.urlencodedRows;
				rows.splice(index, 1);
				if (!rows.length) rows.push(this.state.mode === 'multipart' ? createMultipartRow() : createEditorRow());
			},
			clearMultipartValue(row) {
				row.value = '';
				row.file = null;
				row.fileName = '';
				row.filePath = '';
			},
			selectFile(row, event) {
				const file = event.target.files?.[0] || null;
				row.file = file;
				row.fileName = file?.name || '';
				row.filePath = '';
				event.target.value = '';
			},
			formatBytes(size) {
				if (!Number.isFinite(size) || size < 1024) return `${size || 0} B`;
				if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
				return `${(size / 1024 / 1024).toFixed(1)} MB`;
			},
			formatJson() {
				try {
					this.jsonText = JSON.stringify(JSON.parse(this.jsonText), null, 2);
					ElMessage.success('JSON 已格式化。');
				} catch {
					ElMessage.error('JSON 语法错误。');
				}
			},
			buildPayload() {
				return buildRequestBody(this.getDraft());
			},
			buildAndEmit() {
				try {
					const payload = this.buildPayload();
					this.$emit('submit-payload', payload);
					return true;
				} catch (error) {
					ElMessage.error(error.message);
					return false;
				}
			},
			getDraft() {
				const mode = this.state.mode;
				if (mode === 'raw') return { type: mode, text: this.rawText, contentType: this.rawContentType };
				if (mode === 'json') return { type: mode, text: this.jsonText };
				if (mode === 'urlencoded') return { type: mode, rows: normalizeEditorRows(this.urlencodedRows) };
				if (mode === 'multipart') return { type: mode, rows: this.multipartRows.map((row) => ({ ...row })) };
				return { type: 'none' };
			},
			applyDraft(draft = {}) {
				const type = ['none', 'raw', 'json', 'urlencoded', 'multipart'].includes(draft.type) ? draft.type : 'none';
				this.state.mode = type;
				if (type === 'raw') {
					this.rawText = String(draft.text ?? '');
					this.rawContentType = String(draft.contentType || 'text/plain;charset=utf-8');
				} else if (type === 'json') this.jsonText = String(draft.text ?? '');
				else if (type === 'urlencoded') this.urlencodedRows = normalizeEditorRows(draft.rows);
				else if (type === 'multipart') {
					const rows = Array.isArray(draft.rows) ? draft.rows.map(createMultipartRow) : [];
					this.multipartRows = rows.length ? rows : [createMultipartRow()];
				}
			},
			resetAll() {
				this.state.mode = 'none';
				this.rawText = '';
				this.rawContentType = 'text/plain;charset=utf-8';
				this.jsonText = '';
				this.urlencodedRows = [createEditorRow()];
				this.multipartRows = [createMultipartRow()];
			}
		}
	};
</script>

<style scoped>
	.request-body { width: 100%; margin: 4px auto; }
	.body-toolbar { display: flex; gap: 12px; justify-content: space-between; flex-wrap: wrap; margin-bottom: 16px; }
	.body-actions, .json-actions, .file-picker { display: flex; gap: 8px; align-items: center; }
	.body-editor, .multipart-editor { display: grid; gap: 12px; }
	.file-button { cursor: pointer; color: #409eff; border: 1px solid #409eff; border-radius: 4px; padding: 5px 10px; white-space: nowrap; }
	.file-button input { display: none; }
	.missing-file { color: #e6a23c; }
	@media (max-width: 768px) {
		.body-toolbar, .body-actions { flex-direction: column; align-items: stretch; }
		:deep(.el-radio-group) { display: grid; }
	}
</style>
