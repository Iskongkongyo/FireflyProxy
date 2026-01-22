// 测试服务器
const express = require('express');
const app = express();
const port = 3000;

// 解析各种类型的 Body
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.text());
app.use(express.raw({ type: '*/*' })); // 捕获其他所有 raw 数据

// 捕获所有请求并回显
app.use((req, res) => {
    const timestamp = new Date().toISOString();
    console.log(`\n================================`);
    console.log(`[${timestamp}] 收到请求: ${req.method} ${req.originalUrl}`);
    console.log(`> Headers:`, JSON.stringify(req.headers, null, 2));
    console.log(`> Body:`, req.body);
    console.log(`================================\n`);

    // 构造回显数据
    const echoData = {
        meta: {
            desc: "Echo Server Response",
            time: timestamp,
            note: "此服务器未设置 CORS 头，如果您在浏览器看到此响应，说明代理工作正常！"
        },
        request: {
            method: req.method,
            url: req.originalUrl,
            headers: req.headers, // 关键：检查这里是否包含您自定义的 header
            query: req.query,
            body: req.body instanceof Buffer ? req.body.toString() : req.body // 处理 Buffer
        }
    };

    // 故意不设置 CORS 头
    // res.setHeader('Access-Control-Allow-Origin', '*'); 

    res.status(200).json(echoData);
});

app.listen(port, () => {
    console.log(`\n✅ Echo 测试服务器已启动: http://localhost:${port}`);
    console.log(`请在您的代理应用中输入此 URL 进行测试，查看 Headers 和 Body 是否被正确转发。`);
});
