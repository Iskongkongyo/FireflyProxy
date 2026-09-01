function createAdminPage() {
    return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>proxyWeb 配置管理</title>
<style>
:root{color-scheme:light;--bg:#f4f7fb;--panel:#fff;--text:#1f2937;--muted:#64748b;--line:#dbe3ef;--primary:#2563eb;--danger:#dc2626;--ok:#15803d}*{box-sizing:border-box}body{margin:0;background:linear-gradient(135deg,#eef4ff,#f8fafc 45%,#ecfeff);color:var(--text);font:14px/1.5 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}.shell{max-width:1240px;margin:auto;padding:28px 20px 72px}.hero{display:flex;justify-content:space-between;gap:20px;align-items:center;margin-bottom:22px}.hero h1{margin:0;font-size:28px}.hero p{margin:6px 0 0;color:var(--muted)}.badge{padding:7px 12px;border-radius:999px;background:#dbeafe;color:#1d4ed8;font-weight:700}.notice{display:none;margin:0 0 18px;padding:12px 14px;border-radius:10px;background:#eff6ff;border:1px solid #bfdbfe}.notice.error{display:block;background:#fef2f2;border-color:#fecaca;color:#991b1b}.notice.ok{display:block;background:#f0fdf4;border-color:#bbf7d0;color:#166534}.toolbar{position:sticky;top:0;z-index:5;display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:18px;padding:12px 14px;border:1px solid var(--line);border-radius:14px;background:rgba(255,255,255,.94);backdrop-filter:blur(10px);box-shadow:0 8px 30px rgba(15,23,42,.07)}button{border:0;border-radius:9px;padding:10px 16px;font-weight:700;cursor:pointer}button.primary{background:var(--primary);color:#fff}button.secondary{background:#e2e8f0;color:#334155}button:disabled{opacity:.55;cursor:wait}.sections{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}.section{padding:20px;border:1px solid var(--line);border-radius:16px;background:var(--panel);box-shadow:0 10px 28px rgba(15,23,42,.055)}.section h2{margin:0 0 4px;font-size:18px}.section>p{margin:0 0 18px;color:var(--muted)}.fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.field{min-width:0}.field.wide{grid-column:1/-1}.field label{display:block;margin-bottom:6px;font-weight:700}.field small{display:block;margin-top:5px;color:var(--muted)}input,select,textarea{width:100%;border:1px solid #cbd5e1;border-radius:8px;padding:9px 10px;background:#fff;color:var(--text);font:inherit}textarea{min-height:82px;resize:vertical}input:focus,select:focus,textarea:focus{outline:2px solid #bfdbfe;border-color:#60a5fa}.check{display:flex;align-items:center;gap:9px;padding-top:8px}.check input{width:auto}.secret-row{display:flex;gap:8px}.secret-row input{flex:1}.clear-secret{white-space:nowrap;padding:8px 10px;background:#fee2e2;color:#991b1b}.restart{color:#b45309}.footer-note{margin-top:18px;color:var(--muted)}@media(max-width:900px){.sections{grid-template-columns:1fr}}@media(max-width:620px){.shell{padding:18px 12px 60px}.hero{align-items:flex-start;flex-direction:column}.fields{grid-template-columns:1fr}.field.wide{grid-column:auto}.toolbar{align-items:stretch;flex-direction:column}.toolbar div{display:flex;gap:8px}.toolbar button{flex:1}}
</style>
</head>
<body><main class="shell">
<header class="hero"><div><h1>proxyWeb 配置管理</h1><p>编辑 main.json，保存前执行完整 Schema 与安全边界校验。</p></div><span class="badge">Admin Console</span></header>
<div id="notice" class="notice"></div>
<div class="toolbar"><span id="status">正在读取配置…</span><div><button id="reload" class="secondary">重新读取</button><button id="save" class="primary">校验并保存</button></div></div>
<form id="form"><div id="sections" class="sections"></div></form>
<p class="footer-note">密码和 Session Secret 不会返回到浏览器；密码框留空表示保持原值。带“需重启”的设置写入后必须重启后端进程才完全生效。</p>
</main>
<script>
const definitions=[
 {title:'Cookie Bridge',desc:'Maps document.cookie to the current upstream Origin. Enable only for trusted compatibility targets.',fields:[
  ['browser.scriptCookieBridge','Script Cookie Bridge','boolean','Requires HTML Rewrite and Runtime Bridge']
 ]},
 {title:'管理控制面',desc:'独立于代理认证。修改路径或凭据后，下一次访问立即使用新值。',fields:[
  ['admin.enabled','启用管理页面','boolean'],['admin.path','管理路径','text','例如 /admin 或 /control/settings'],['admin.user','管理用户名','text'],['admin.pwd','管理密码','secret','留空保持原密码']
 ]},
 {title:'服务与代理认证',desc:'监听与 Express 启动参数修改后需要重启。',fields:[
  ['port','监听端口','number','需重启'],['trustProxy','信任反向代理','json','Boolean、数字、字符串或字符串数组；需重启'],['timeoutMs','请求超时（ms）','number'],['user','代理用户名','text'],['pwd','代理密码','secret','留空保持；清除后代理认证关闭'],['defaultSkip','默认跳转地址','text']
 ]},
 {title:'Session',desc:'Session 中间件参数均需重启后完全生效。',fields:[
  ['session.secret','Session Secret','secret','留空保持；需重启'],['session.name','Cookie 名称','text','需重启'],['session.maxAgeMs','有效期（ms）','number','需重启'],['session.resave','Resave','boolean'],['session.saveUninitialized','保存未初始化 Session','boolean'],['session.secure','Secure Cookie','boolean'],['session.httpOnly','HttpOnly Cookie','boolean'],['session.sameSite','SameSite','select','', ['lax','strict','none','false']]
 ]},
 {title:'CORS',desc:'只控制 API/Legacy；Browser Canonical Route 使用独立边界。',fields:[
  ['cors.allowedOrigins','允许的 Origin','lines','每行一个 Origin；* 不能与凭据同时使用'],['cors.allowCredentials','允许凭据','boolean']
 ]},
 {title:'窗口限流',desc:'配置可热加载；关闭不影响并发、Body、超时与 WebSocket 上限。',fields:[
  ['limiter.enabled','启用限流','boolean'],['limiter.windowMs','窗口（ms）','number'],['limiter.max','窗口最大请求数','number'],['limiter.statusCode','拒绝状态码','number'],['limiter.message','拒绝消息','text']
 ]},
 {title:'安全策略',desc:'SSRF 防护建议始终开启；私网访问只适合受控环境。',fields:[
  ['security.ssrf','启用 SSRF 防护','boolean'],['security.allowPrivateNetworks','允许私网目标','boolean'],['security.blockedHostnames','阻止的主机名','lines','每行一个精确主机或 *.example.com'],['security.maxRewriteBytes','最大改写字节数','number']
 ]},
 {title:'API Mode',desc:'API 忠实转发、Redirect 与资源边界。',fields:[
  ['api.followRedirects','跟随重定向','boolean'],['api.maxRedirects','最大重定向次数','number'],['api.connectTimeoutMs','连接超时（ms）','number'],['api.maxRequestBodyBytes','最大请求 Body','number'],['api.maxConcurrentRequests','最大并发请求','number']
 ]},
 {title:'Browser Mode',desc:'网页兼容、Runtime、WebSocket 与 Origin Isolation。',fields:[
  ['browser.enabled','启用网页代理','boolean'],['browser.maxRedirects','最大重定向次数','number'],['browser.rewriteHtml','改写 HTML','boolean'],['browser.rewriteCss','改写 CSS','boolean'],['browser.cookieJar','启用 Cookie Jar','boolean'],['browser.runtimeBridge','启用 Runtime Bridge','boolean'],['browser.webSocket','启用 WebSocket','boolean'],['browser.webSocketMaxPayloadBytes','WebSocket 最大消息','number'],['browser.webSocketIdleTimeoutMs','WebSocket 空闲超时','number'],['browser.webSocketMaxConnections','WebSocket 最大连接','number'],['browser.headerPolicy','响应头策略','select','', ['strict','preserve','compat']],['browser.originIsolation.enabled','启用 Origin Isolation','boolean'],['browser.originIsolation.baseOrigin','隔离基础 Origin','text','生产要求专用 HTTPS 三级域名']
 ]}
];
let snapshot=null;const secretClears=new Set();const $=s=>document.querySelector(s);const apiPath=location.pathname.replace(/\\/+$/,'')+'/api/config';
function getPath(obj,path){return path.split('.').reduce((value,key)=>value?.[key],obj)}
function setPath(obj,path,value){const keys=path.split('.');let valueObj=obj;for(const key of keys.slice(0,-1)){valueObj[key]??={};valueObj=valueObj[key]}valueObj[keys.at(-1)]=value}
function escapeHtml(value){return String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]))}
function fieldHtml(field){const [path,label,type,help='',choices=[]]=field;const value=getPath(snapshot.config,path);const id='f-'+path.replaceAll('.','-');const wide=['lines','json','text'].includes(type)&&path.includes('message');let control='';
 if(type==='boolean')control='<label class="check"><input id="'+id+'" data-path="'+path+'" data-type="boolean" type="checkbox" '+(value?'checked':'')+'> 启用</label>';
 else if(type==='lines')control='<textarea id="'+id+'" data-path="'+path+'" data-type="lines">'+escapeHtml((value||[]).join('\\n'))+'</textarea>';
 else if(type==='json')control='<textarea id="'+id+'" data-path="'+path+'" data-type="json">'+escapeHtml(JSON.stringify(value))+'</textarea>';
 else if(type==='select')control='<select id="'+id+'" data-path="'+path+'" data-type="select">'+choices.map(v=>'<option '+(String(value)===v?'selected':'')+' value="'+v+'">'+v+'</option>').join('')+'</select>';
 else if(type==='secret'){const has=snapshot.secrets[path];control='<div class="secret-row"><input id="'+id+'" data-path="'+path+'" data-type="secret" type="password" autocomplete="new-password" placeholder="'+(has?'已配置；留空保持':'尚未配置')+'"><button type="button" class="clear-secret" data-clear="'+path+'">清除</button></div>'}
 else control='<input id="'+id+'" data-path="'+path+'" data-type="'+type+'" type="'+(type==='number'?'number':'text')+'" value="'+escapeHtml(value)+'">';
 return '<div class="field '+(wide?'wide':'')+'"><label for="'+id+'">'+label+'</label>'+control+(help?'<small class="'+(help.includes('需重启')?'restart':'')+'">'+help+'</small>':'')+'</div>'}
function render(){secretClears.clear();$('#sections').innerHTML=definitions.map(section=>'<section class="section"><h2>'+section.title+'</h2><p>'+section.desc+'</p><div class="fields">'+section.fields.map(fieldHtml).join('')+'</div></section>').join('');document.querySelectorAll('[data-clear]').forEach(button=>button.onclick=()=>{const path=button.dataset.clear;secretClears.add(path);const input=document.querySelector('[data-path="'+path+'"]');input.value='';input.placeholder='保存后清除';button.textContent='将清除';button.disabled=true})}
function collect(){const config=structuredClone(snapshot.config);document.querySelectorAll('[data-path]').forEach(input=>{let value;const type=input.dataset.type;if(type==='boolean')value=input.checked;else if(type==='number'){value=Number(input.value);if(!Number.isFinite(value))throw new Error(input.dataset.path+' 必须是数字')}else if(type==='lines')value=input.value.split(/\\r?\\n/).map(v=>v.trim()).filter(Boolean);else if(type==='json'){try{value=JSON.parse(input.value)}catch{throw new Error(input.dataset.path+' 不是有效 JSON')}}else if(type==='select')value=input.value==='false'?false:input.value;else if(type==='secret')value=secretClears.has(input.dataset.path)?'':(input.value||null);else value=input.value;setPath(config,input.dataset.path,value)});return config}
function notice(message,type='ok'){const box=$('#notice');box.className='notice '+type;box.textContent=message}
async function load(){try{$('#status').textContent='正在读取配置…';const response=await fetch(apiPath,{cache:'no-store'});const body=await response.json();if(!response.ok)throw new Error(body.error?.message||'读取失败');snapshot=body;render();$('#status').textContent='已读取当前运行配置';$('#notice').className='notice'}catch(error){notice(error.message,'error');$('#status').textContent='读取失败'}}
async function save(){const button=$('#save');try{button.disabled=true;$('#status').textContent='正在校验并保存…';const response=await fetch(apiPath,{method:'PUT',headers:{'content-type':'application/json','x-proxyweb-admin':'1'},body:JSON.stringify({config:collect()})});const body=await response.json();if(!response.ok)throw new Error(body.error?.message||'保存失败');const restart=body.restartRequired?.length?'；需重启字段：'+body.restartRequired.join(', '):'；热加载已生效';notice('配置保存成功'+restart);$('#status').textContent='保存成功';const currentPath=location.pathname.replace(/\\/+$/,'');if(!body.adminEnabled){notice('配置已保存，管理页面现已关闭'+restart);return}if(body.adminPath!==currentPath||body.adminCredentialsChanged){setTimeout(()=>location.assign(body.adminPath),900);return}await load()}catch(error){notice(error.message,'error');$('#status').textContent='保存失败'}finally{button.disabled=false}}
$('#reload').onclick=load;$('#save').onclick=save;load();
</script></body></html>`;
}

module.exports = { createAdminPage };
