<template>
    <nav class="mode-switcher" aria-label="代理模式">
        <el-button-group>
            <el-button :type="apiActive ? 'primary' : 'default'" @click="go('/')">
                API 请求
            </el-button>
            <el-button :type="browserActive ? 'primary' : 'default'" @click="go('/browser')">
                网页代理
            </el-button>
        </el-button-group>
    </nav>
</template>

<script>
export default {
    name: 'ModeSwitcher',
    computed: {
        apiActive() {
            return this.$route.name === 'RequestForm';
        },
        browserActive() {
            return this.$route.name === 'BrowserProxy';
        }
    },
    methods: {
        go(path) {
            if (this.$route.path !== path) this.$router.push(path);
        }
    }
};
</script>

<style scoped>
.mode-switcher {
    display: flex;
    justify-content: center;
    margin: 0 0 22px;
}

.mode-switcher :deep(.el-button) {
    min-width: 128px;
}
</style>
