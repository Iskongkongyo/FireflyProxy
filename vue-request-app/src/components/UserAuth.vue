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

			<el-form v-else label-position="top">
				<el-form-item label="Bearer Token">
					<el-input v-model="auth.bearerAuth" size="large" clearable show-password autocomplete="off"
						placeholder="输入 Token，发送时会自动添加 Bearer 前缀" />
				</el-form-item>
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
				bearerAuth: ''
			},
			options: [
				{ value: 'No Auth', label: '无需认证' },
				{ value: 'Basic Auth', label: 'Basic Auth（用户名与密码）' },
				{ value: 'Bearer Auth', label: 'Bearer Token' }
			],
			result: ''
		};
	},
	computed: {
		selectedDescription() {
			if (this.value === 'Basic Auth') return '将用户名和密码编码后写入 Authorization: Basic 请求头。';
			if (this.value === 'Bearer Auth') return '将 Token 写入 Authorization: Bearer 请求头。';
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
			this.$emit('userAuth', this.result);
			return this.result;
		},
		getDraft() {
			if (this.value === 'Basic Auth') {
				return { type: 'basic', username: this.auth.basicAuth.username, password: this.auth.basicAuth.password };
			}
			if (this.value === 'Bearer Auth') return { type: 'bearer', token: this.auth.bearerAuth };
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
.auth-fields :deep(.el-form-item) { margin-bottom: 8px; }

@media (max-width: 700px) {
	.auth-editor { grid-template-columns: 1fr; gap: 18px; }
	.auth-type { padding: 0 0 17px; border-right: 0; border-bottom: 1px solid #edf0f5; }
	.field-grid { grid-template-columns: 1fr; gap: 0; }
}
</style>
