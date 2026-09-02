<template>
    <nav class="mode-switcher" aria-label="主要功能">
        <button
            v-for="item in items"
            :key="item.path"
            type="button"
            class="mode-item"
            :class="{ active: item.activeNames.includes($route.name) }"
            :aria-current="item.activeNames.includes($route.name) ? 'page' : undefined"
            @click="go(item.path)"
        >
            <span class="mode-icon" aria-hidden="true">{{ item.icon }}</span>
            <span class="mode-copy">
                <strong>{{ item.label }}</strong>
                <small>{{ item.description }}</small>
            </span>
        </button>
    </nav>
</template>

<script>
export default {
    name: 'ModeSwitcher',
    data() {
        return {
            items: [
                { path: '/', activeNames: ['RequestForm'], icon: '⇄', label: 'API 请求', description: '调试 HTTP 接口' },
                { path: '/browser', activeNames: ['BrowserProxy'], icon: '◎', label: '网页代理', description: '安全打开目标网页' },
                { path: '/history', activeNames: ['HistoryRecord'], icon: '◷', label: '请求历史', description: '查找已保存链接' }
            ]
        };
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
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 10px;
    width: min(1120px, 100%);
    margin: 0 auto 18px;
    padding: 6px;
    border: 1px solid #e5eaf2;
    border-radius: 14px;
    background: rgba(255, 255, 255, 0.9);
    box-shadow: 0 8px 24px rgba(31, 45, 61, 0.05);
}

.mode-item {
    display: flex;
    align-items: center;
    gap: 11px;
    min-width: 0;
    padding: 11px 14px;
    color: #606b7a;
    text-align: left;
    border: 0;
    border-radius: 10px;
    background: transparent;
    cursor: pointer;
    transition: color 0.2s ease, background 0.2s ease, box-shadow 0.2s ease;
}

.mode-item:hover {
    color: #1677ff;
    background: #f3f8ff;
}

.mode-item.active {
    color: #0958d9;
    background: #eaf3ff;
    box-shadow: inset 0 0 0 1px #b9d7ff;
}

.mode-icon {
    display: grid;
    flex: 0 0 34px;
    width: 34px;
    height: 34px;
    place-items: center;
    color: #1677ff;
    font-size: 20px;
    font-weight: 700;
    border-radius: 9px;
    background: #fff;
    box-shadow: 0 3px 10px rgba(22, 119, 255, 0.12);
}

.mode-copy {
    display: grid;
    min-width: 0;
    gap: 2px;
}

.mode-copy strong {
    font-size: 14px;
    line-height: 1.3;
}

.mode-copy small {
    overflow: hidden;
    color: #8993a4;
    font-size: 12px;
    line-height: 1.3;
    text-overflow: ellipsis;
    white-space: nowrap;
}

@media (max-width: 680px) {
    .mode-switcher {
        gap: 4px;
        padding: 4px;
    }

    .mode-item {
        justify-content: center;
        padding: 10px 6px;
    }

    .mode-icon,
    .mode-copy small {
        display: none;
    }

    .mode-copy strong {
        font-size: 13px;
        white-space: nowrap;
    }
}
</style>
