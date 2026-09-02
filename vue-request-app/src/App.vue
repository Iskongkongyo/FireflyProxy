<template>
	<div class="app-shell">
		<router-view @update-message="handleMessageUpdate" />
		<footer v-if="isShow" class="app-footer">
			<span>FireflyProxy · 让接口与网页代理调试更简单</span>
			<a href="https://github.com/Iskongkongyo/PostmanWeb" target="_blank" rel="noopener noreferrer">查看项目</a>
		</footer>
	</div>
</template>

<script>
export default {
	name: 'App',
	data() {
		return { isShow: false };
	},
	methods: {
		handleMessageUpdate(message) {
			this.isShow = message;
		}
	}
};
</script>

<style>
:root {
	color-scheme: light;
	--app-bg: #f4f7fb;
	--app-text: #1f2937;
	--app-muted: #667085;
	--app-border: #e5eaf2;
	--app-primary: #1677ff;
}

* { box-sizing: border-box; }

html,
body,
#app {
	min-height: 100%;
	margin: 0;
}

body {
	background: radial-gradient(circle at 12% 0%, rgba(22, 119, 255, 0.08), transparent 28rem), var(--app-bg);
}

button,
input,
textarea,
select { font: inherit; }

#app {
	color: var(--app-text);
	font-family: Inter, "PingFang SC", "Microsoft YaHei", Arial, sans-serif;
	-webkit-font-smoothing: antialiased;
	-moz-osx-font-smoothing: grayscale;
}

.app-shell { min-height: 100vh; }

.app-footer {
	display: flex;
	align-items: center;
	justify-content: center;
	gap: 12px;
	padding: 18px 20px 24px;
	color: #8a94a6;
	font-size: 13px;
}

.app-footer a {
	color: var(--app-primary);
	text-decoration: none;
}

.app-footer a:hover { text-decoration: underline; }

@media (max-width: 640px) {
	.app-footer {
		align-items: flex-start;
		flex-direction: column;
		padding-inline: 18px;
	}
}
</style>
