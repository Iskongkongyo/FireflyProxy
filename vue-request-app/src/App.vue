<template>
	<div v-if="isShow" style="text-align: right;"><a href="https://github.com/Iskongkongyo/PostmanWeb"
			target="_blank"><img style="width:60px;height:50px" src="../public/github.png" /></a></div><br />
	<router-view @update-message="handleMessageUpdate"></router-view>
	<div class="footer">
		Copyright &copy; <a href="https://github.com/Iskongkongyo" target="_blank">Iskongkongyo</a> All Rights
		Reserved
	</div>
</template>

<script>
	export default {
		name: 'App',
		components: {},
		data() {
			return {
				isShow: false
			}
		},
		methods: {
			handleMessageUpdate(message) {
				this.isShow = message;
			}
		}
	}
</script>

<style>
	#app {
		font-family: Avenir, Helvetica, Arial, sans-serif;
		-webkit-font-smoothing: antialiased;
		-moz-osx-font-smoothing: grayscale;
		text-align: center;
		color: #2c3e50;
		margin-top: 10px;
	}

	.footer {
		position: fixed;
		left: 0;
		right: 0;
		bottom: 0;
		padding: 12px 10px;
		color: #7e7e7e;
		text-align: center;
		background: rgba(255, 255, 255, 1);
		box-shadow: 0 -4px 12px rgba(0, 0, 0, 0);
		z-index: 999;
		padding-bottom: 20px;
	}

	.footer a {
		color: #ff4665;
		text-decoration: none;
	}
</style>