<template>
	<div class="container">
		<el-select class="options" v-model="value" placeholder="Select" size="large" style="width: 240px">
			<el-option v-for="item in options" :key="item.value" :label="item.label" :value="item.value" />
		</el-select>

		<el-divider direction="vertical" class="divider" />

		<div class="auth">

			<!-- Basic Auth -->
			<div v-show="value === 'Basic Auth' ? true : false">
				Username：<el-input v-model="auth.basicAuth.username" style="width: 240px" placeholder="请输入用户名"
					:size="large" clearable /><br /><br />
				Password：<el-input v-model="auth.basicAuth.password" style="width: 240px" placeholder="请输入密码"
					:size="large" clearable />
			</div>

			<!-- Bearer Auth -->
			<div v-show="value === 'Bearer Auth' ? true : false">
				Bearer Auth：<el-input v-model="auth.bearerAuth" style="width: 240px" placeholder="请输入Token"
					:size="large" clearable />
			</div>

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
					basicAuth: {
						username: "",
						password: ""
					},
					bearerAuth: ''
				},
				options: [{
						value: 'No Auth',
						label: 'No Auth',
					},
					{
						value: 'Basic Auth',
						label: 'Basic Auth',
					},
					{
						value: 'Bearer Auth',
						label: 'Bearer Auth',
					}
				],
				result: ''
			};
		},
		methods: {
			basicAuth() {
				if (this.auth.basicAuth.username != '' || this.auth.basicAuth.password != '') {
					this.result = 'Basic ' + btoa(this.auth.basicAuth.username + ':' + this.auth.basicAuth.password);
				} else {
					this.result = '';
				}
			},
			bearerAuth() {
				if (this.auth.bearerAuth != '') {
					this.result = 'Bearer ' + this.auth.bearerAuth;
				} else {
					this.result = '';
				}
			},
			handle() {
				if (this.value === 'No Auth') {
					this.result = '';
				} else if (this.value === 'Basic Auth') {
					this.basicAuth();
				} else if (this.value === 'Bearer Auth') {
					this.bearerAuth();
				}
				this.$emit('userAuth', this.result);
			}
		},
	};
</script>

<style scoped>
	.container {
		display: flex;
		align-items: center;
		gap: 12px;
		width: 100%;
	}

	.options {
		flex: 3;
		min-width: 0;
	}

	.divider {
		flex: 1;
		height: 2em;
		margin: 0 8px;
	}

	.auth {
		flex: 10;
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		width: 100%;
	}

	/* 覆盖Element默认margin */
	:deep(.el-divider--vertical) {
		margin: 0;
	}
</style>