const { defineConfig } = require('@vue/cli-service')
module.exports = defineConfig({
  transpileDependencies: true,
  // 打包后的资源路径前缀，匹配后端 /web 路由
  publicPath: '/web/',
  // 可选：打包输出目录（默认是 dist）
  // outputDir: '../backend/nodejs/webPro'
})
