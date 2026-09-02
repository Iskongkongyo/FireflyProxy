<template>
	<div class="auth-editor">
		<div class="auth-type">
			<label for="auth-type-select">认证类型</label>
			<el-select id="auth-type-select" v-model="value" size="large">
				<el-option v-for="item in options" :key="item.value" :label="item.label" :value="item.value" />
			</el-select>
			<p>{{ selectedDescription }}</p>
		</div>

		<div class="auth-fields">
			<el-empty v-if="value === 'No Auth'" description="当前请求不添加 Authorization 请求头" :image-size="64" />

			<el-form v-else-if="value === 'Basic Auth'" label-position="top">
				<div class="field-grid">
					<el-form-item label="用户名">
						<el-input v-model="auth.basicAuth.username" size="large" clearable autocomplete="username"
							placeholder="输入 Basic Auth 用户名" />
					</el-form-item>
					<el-form-item label="密码">
						<el-input v-model="auth.basicAuth.password" size="large" clearable show-password
							autocomplete="current-password" placeholder="输入 Basic Auth 密码" />
					</el-form-item>
				</div>
			</el-form>

			<el-form v-else-if="value === 'Bearer Auth'" label-position="top">
				<el-form-item label="Bearer Token">
					<el-input v-model="auth.bearerAuth" size="large" clearable show-password autocomplete="off"
						placeholder="输入 Token，发送时会自动添加 Bearer 前缀" />
				</el-form-item>
			</el-form>

			<el-form v-else-if="value === 'API Key'" label-position="top">
				<div class="api-key-grid">
					<el-form-item label="添加到">
						<el-select v-model="auth.apiKeyAuth.addTo" size="large">
							<el-option label="请求头（推荐）" value="header" />
							<el-option label="查询参数" value="query" />
						</el-select>
					</el-form-item>
					<el-form-item :label="auth.apiKeyAuth.addTo === 'header' ? '请求头名称' : '参数名称'">
						<el-input v-model="auth.apiKeyAuth.key" size="large" clearable autocomplete="off"
							placeholder="例如：X-API-Key；支持 {{ variable }}" />
					</el-form-item>
				</div>
				<el-form-item label="API Key 值">
					<el-input v-model="auth.apiKeyAuth.value" size="large" clearable show-password autocomplete="off"
						placeholder="输入密钥；推荐使用 {{ apiKey }} Secret 环境变量" />
				</el-form-item>
				<el-alert v-if="auth.apiKeyAuth.addTo === 'query'" class="api-key-warning" type="warning"
					:closable="false" show-icon title="查询参数会出现在目标 URL、重定向诊断和外部访问日志中，仅在目标接口明确要求时使用。" />
				<p class="auth-note">若请求头或参数表中已有同名启用项，将优先使用手工编辑的值。</p>
			</el-form>

			<el-alert v-if="value !== 'No Auth'" type="warning" :closable="false" show-icon
				title="认证信息属于敏感数据。复制 cURL 或分享链接时请仔细检查，工作区保存也应选择合适的 Secret 变量。" />
		</div>
	</div>
</template>

<script>
export default {
	name: 'UserAuth',
	data() {
		return {
			value: 'No Auth',
				auth: {
					basicAuth: { username: '', password: '' },
					bearerAuth: '',
					apiKeyAuth: { key: 'X-API-Key', value: '', addTo: 'header' }
				},
			options: [
				{ value: 'No Auth', label: '无需认证' },
				{ value: 'Basic Auth', label: 'Basic Auth（用户名与密码）' },
				{ value: 'Bearer Auth', label: 'Bearer Token' },
				{ value: 'API Key', label: 'API Key' }
			],
			result: ''
		};
	},
	computed: {
		selectedDescription() {
			if (this.value === 'Basic Auth') return '将用户名和密码编码后写入 Authorization: Basic 请求头。';
			if (this.value === 'Bearer Auth') return '将 Token 写入 Authorization: Bearer 请求头。';
			if (this.value === 'API Key') return '把密钥加入请求头或查询参数；默认使用更安全的请求头方式。';
			return '适用于公开接口或自行在“请求头”中配置认证信息的场景。';
		}
	},
	methods: {
		encodeBasic(value) {
			const bytes = new TextEncoder().encode(value);
			let binary = '';
			bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
			return btoa(binary);
		},
		basicAuth() {
			if (this.auth.basicAuth.username !== '' || this.auth.basicAuth.password !== '') {
				this.result = `Basic ${this.encodeBasic(`${this.auth.basicAuth.username}:${this.auth.basicAuth.password}`)}`;
			} else {
				this.result = '';
			}
		},
		bearerAuth() {
			this.result = this.auth.bearerAuth !== '' ? `Bearer ${this.auth.bearerAuth}` : '';
		},
		handle() {
			if (this.value === 'No Auth') this.result = '';
			else if (this.value === 'Basic Auth') this.basicAuth();
			else if (this.value === 'Bearer Auth') this.bearerAuth();
			else if (this.value === 'API Key') this.result = '';
			this.$emit('userAuth', this.result);
			return this.result;
		},
		getDraft() {
			if (this.value === 'Basic Auth') {
				return { type: 'basic', username: this.auth.basicAuth.username, password: this.auth.basicAuth.password };
			}
			if (this.value === 'Bearer Auth') return { type: 'bearer', token: this.auth.bearerAuth };
			if (this.value === 'API Key') return {
				type: 'apiKey',
				key: this.auth.apiKeyAuth.key,
				value: this.auth.apiKeyAuth.value,
				addTo: this.auth.apiKeyAuth.addTo
			};
			return { type: 'none' };
		},
		applyDraft(draft = {}) {
			if (draft.type === 'basic') {
				this.value = 'Basic Auth';
				this.auth.basicAuth.username = String(draft.username ?? '');
				this.auth.basicAuth.password = String(draft.password ?? '');
			} else if (draft.type === 'bearer') {
				this.value = 'Bearer Auth';
				this.auth.bearerAuth = String(draft.token ?? '');
			} else if (draft.type === 'apiKey') {
				this.value = 'API Key';
				this.auth.apiKeyAuth.key = String(draft.key ?? 'X-API-Key');
				this.auth.apiKeyAuth.value = String(draft.value ?? '');
				this.auth.apiKeyAuth.addTo = draft.addTo === 'query' ? 'query' : 'header';
			} else {
				this.value = 'No Auth';
			}
			this.handle();
		}
	}
};
</script>

<style scoped>
.auth-editor { display: grid; grid-template-columns: 260px minmax(0, 1fr); gap: 28px; }
.auth-type { padding-right: 24px; border-right: 1px solid #edf0f5; }
.auth-type label { display: block; margin-bottom: 8px; color: #344054; font-size: 13px; font-weight: 700; }
.auth-type :deep(.el-select) { width: 100%; }
.auth-type p { margin: 12px 0 0; color: #7b8798; font-size: 12px; line-height: 1.65; }
.auth-fields { display: grid; align-content: start; gap: 14px; min-width: 0; }
.field-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.api-key-grid { display: grid; grid-template-columns: minmax(180px, 0.7fr) minmax(260px, 1.3fr); gap: 14px; }
.api-key-grid :deep(.el-select) { width: 100%; }
.api-key-warning { margin-bottom: 10px; }
.auth-note { margin: 0; color: #7b8798; font-size: 12px; line-height: 1.6; }
.auth-fields :deep(.el-form-item) { margin-bottom: 8px; }

@media (max-width: 700px) {
	.auth-editor { grid-template-columns: 1fr; gap: 18px; }
	.auth-type { padding: 0 0 17px; border-right: 0; border-bottom: 1px solid #edf0f5; }
	.field-grid { grid-template-columns: 1fr; gap: 0; }
	.api-key-grid { grid-template-columns: 1fr; gap: 0; }
}
</style>
