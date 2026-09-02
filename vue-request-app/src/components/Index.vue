<template>
	<main v-if="isShow" class="api-page" @keydown="handlePageKeydown">
		<ModeSwitcher />

		<header class="page-hero">
			<div>
				<span class="eyebrow">HTTP CLIENT</span>
				<h1>API 请求</h1>
				<p>组合请求地址、参数、认证与请求体，并在同一页面查看响应状态、跳转链路和内容。</p>
			</div>
			<div class="environment-status">
				<span class="status-dot"></span>
				<div>
					<strong>{{ activeEnvironment?.name || '未选择环境' }}</strong>
					<small>{{ activeEnvironment ? '环境变量将在发送前解析' : '可在工作区中创建并切换环境' }}</small>
				</div>
				<el-button text type="primary" @click="openWorkspace">管理</el-button>
			</div>
		</header>

		<section class="request-composer" aria-label="请求地址">
			<div class="request-line">
				<el-select v-model="method" class="method-select" size="large" placeholder="请求方法"
					aria-label="请求方法"
					@change="method !== 'GET' && method !== 'HEAD' ? activeTab = 'body' : activeTab = 'params'">
					<el-option v-for="option in methods" :key="option.value" :label="option.label" :value="option.value">
						<template #default>
							<div class="method-option"><span :class="['method-dot', option.type]"></span>{{ option.label }}</div>
						</template>
					</el-option>
				</el-select>
				<el-input v-model="url" class="url-input" size="large" clearable autocomplete="url"
					placeholder="输入完整 API 地址，例如：https://api.example.com/v1/users" aria-label="API 请求地址"
					@input="syncParamsFromUrl" />
				<el-button class="send-button" type="primary" size="large" :loading="isLoading" @click="sendRequest">
					<el-icon v-if="!isLoading" class="el-icon--left"><Search /></el-icon>
					{{ isLoading ? '请求中' : '发送请求' }}
				</el-button>
			</div>
			<div class="composer-help">
				<span>仅支持 HTTP(S) 地址；所有请求仍受后端 SSRF 与 DNS 安全策略约束。</span>
				<div><kbd>Ctrl / ⌘</kbd><span>+</span><kbd>Enter</kbd><span>快速发送</span></div>
			</div>
		</section>

			<!-- 第二行: 操作按钮区 -->
			<el-row :gutter="10" style="margin-bottom: 20px;">
				<el-col :span="24">
					<ActionButtons
						:method="method"
						:activeTab="activeTab"
						:environmentName="activeEnvironment?.name || ''"
						:showDownload="!!downloadUrl"
						@switch-tab="activeTab = $event"
						@add-row="addRow(activeTab)"
						@workspace="openWorkspace"
						@import-curl="openCurlImport"
						@copy-curl="copyAsCurl"
						@copy-page="copy(0)"
						@copy-api="copyApi"
						@download="downloadResponse"
						@history="historyRecords"
					/>
				</el-col>
			</el-row>

			<el-card class="request-editor-card" shadow="never">
				<template #header>
					<div class="editor-heading">
						<div>
							<strong>{{ tabMeta[activeTab]?.title }}</strong>
							<span>{{ tabMeta[activeTab]?.description }}</span>
						</div>
						<el-tag v-if="['headers', 'params'].includes(activeTab)" type="info" effect="plain">
							{{ tableData[activeTab].filter((row) => row.enabled && (row.key || row.value)).length }} 项启用
						</el-tag>
					</div>
				</template>
				<!-- 请求体 -->
				<RequestBody v-show="activeTab === 'body'" @submit-payload="onReceiveBody" ref="body" />

				<!-- 用户验证 -->
				<UserAuth v-show="activeTab === 'auth'" ref="userAuth" />

				<div v-show="activeTab === 'redirect'" class="redirect-settings">
					<el-form label-position="top">
						<div class="redirect-grid">
						<el-form-item label="自动跟随重定向">
							<el-select v-model="redirectSettings.followRedirects" class="boolean-select">
								<el-option label="是，跟随安全的重定向" :value="true" />
								<el-option label="否，返回首跳响应" :value="false" />
							</el-select>
						</el-form-item>
						<el-form-item label="最大重定向次数">
							<el-input-number v-model="redirectSettings.maxRedirects" :min="0" :max="20"
								:disabled="!redirectSettings.followRedirects" controls-position="right" />
						</el-form-item>
						</div>
					</el-form>
					<el-alert title="逐请求设置只能关闭或收紧服务端全局策略；每一跳仍执行 URL、DNS、SSRF 与 Pinning 校验。"
						type="info" :closable="false" show-icon />
				</div>

				<el-alert
					v-if="activeTab === 'headers'"
					class="header-proxy-tip"
					title="浏览器受控请求头会由代理安全处理"
					description="Referer、Origin、Cookie、User-Agent 等浏览器受限字段会通过安全通道转发；Host、Content-Length、连接级和代理身份字段会被忽略。"
					type="info"
					:closable="false"
					show-icon
				/>

				<!-- 动态表格 -->
				<el-table v-if="['headers', 'params'].includes(activeTab)" :data="tableData[activeTab]"
					class="editor-table">
					<el-table-column label="启用" width="68" align="center">
						<template #default="scope">
							<el-switch v-model="scope.row.enabled" :aria-label="`启用第 ${scope.$index + 1} 行`"
								@change="activeTab === 'params' && syncUrlFromParams()" />
						</template>
					</el-table-column>
					<el-table-column prop="key" :label="'名称（'+buttons[activeTab]+')'" min-width="180">
						<template #default="scope">
							<el-autocomplete v-if="activeTab === 'headers'" v-model="scope.row.key"
								class="header-name-autocomplete" clearable placeholder="选择或输入请求头"
								:fetch-suggestions="queryHeaderNames" :trigger-on-focus="true" select-when-unmatched>
								<template #default="{ item }">
									<div class="header-suggestion">
										<strong>{{ item.value }}</strong>
										<span>{{ item.description }}</span>
									</div>
								</template>
							</el-autocomplete>
							<el-input v-else v-model="scope.row.key" clearable placeholder="参数名称"
								@input="syncUrlFromParams" />
						</template>
					</el-table-column>
					<el-table-column prop="value" :label="'值（'+buttons[activeTab]+')'" min-width="260">
						<template #default="scope">
							<el-input v-model="scope.row.value" clearable placeholder="值；支持 {{ variable }} 环境变量"
								@input="activeTab === 'params' && syncUrlFromParams()" />
						</template>
					</el-table-column>
					<el-table-column label="操作" width="88" align="center">
						<template #default="{ $index }">
							<el-button type="danger" link @click="removeRow(activeTab, $index)"><el-icon><Delete /></el-icon>删除</el-button>
						</template>
					</el-table-column>
				</el-table>
			</el-card>

			<el-dialog v-model="curlDialogVisible" title="导入 cURL" width="min(760px, 92vw)" destroy-on-close>
				<el-alert title="仅解析静态文本，不执行命令、变量替换或文件读取。"
					type="info" :closable="false" show-icon />
				<el-input v-model="curlInput" type="textarea" :rows="12" class="curl-input"
					placeholder="粘贴以 curl 开头的命令；多行命令请使用反斜杠续行。" />
				<template #footer>
					<el-button @click="curlDialogVisible = false">取消</el-button>
					<el-button type="primary" @click="applyCurlImport">解析并覆盖编辑器</el-button>
				</template>
			</el-dialog>

			<WorkspacePanel ref="workspace" @load-request="applySavedRequest"
				@environment-change="activeEnvironment = $event" />

			<!-- 响应内容 -->
			<ResponseViewer
				:type="getViewerType()"
				:content="response"
				:url="responseUrl"
				:headers="resHead"
				:fileName="responseFile"
				:isStreaming="isStreaming"
				:loading="isLoading"
				:responseTime="responseTime"
				:responseSize="responseSize"
				:status="responseStatus"
				:statusText="responseStatusText"
				:finalUrl="responseFinalUrl"
				:redirectChain="responseRedirectChain"
				:contentType="responseContentType"
				:diagnosticsTruncated="responseDiagnosticsTruncated"
			/>

			<!-- 返回顶部 -->
			<el-backtop :bottom="100">
				<div class="backup">
					<el-icon>
						<Top />
					</el-icon>
				</div>
			</el-backtop>

	</main>
</template>

<script>
	import {
		watchEffect
	} from 'vue';
	import {
		ElMessage,
		ElMessageBox
	} from 'element-plus';
	import {
		useRoute,
		useRouter
	} from 'vue-router';
	import axios from 'axios';
	import { PROXY_CONFIG, URL_PATTERN } from '../config.js';
	import { parseError } from '../utils/errorHandler.js';
	import { buildProxyTransport } from '../utils/headerSecurity.mjs';
	import { filterHeaderSuggestions } from '../utils/headerCatalog.mjs';
	import {
		activeEditorRows,
		createEditorRow,
		editorRowsToHeaders,
		hasMeaningfulEditorRows,
		normalizeEditorRows,
		parseEditorRows,
		queryRowsFromUrl,
		replaceQueryRows
	} from '../utils/requestEditor.mjs';
	import { exportCurl, parseCurl, requestContainsSecrets, supportsRequestBody } from '../utils/curl.mjs';
	import { buildRequestBody } from '../utils/requestBody.mjs';
	import {
		applyRedirectSettings,
		elapsedMilliseconds,
		normalizeRedirectSettings,
		parseResponseDiagnostics,
		responseByteLength
	} from '../utils/responseDiagnostics.mjs';
	import {
		buildAuthorizationHeader,
		requestUsesSecretVariables,
		resolveRequestDraft
	} from '../utils/workspaceModel.mjs';
	import { buildDirectApiLink, buildRequestPageLink } from '../utils/shareLinks.mjs';

	import UserAuth from './UserAuth.vue';
	import RequestBody from './RequestBody.vue';
	import ActionButtons from './ActionButtons.vue';
	import ResponseViewer from './ResponseViewer.vue';
	import ModeSwitcher from './ModeSwitcher.vue';
	import WorkspacePanel from './WorkspacePanel.vue';
	export default {
		name: 'RequestForm',
		components: {
			UserAuth,
			RequestBody,
			ActionButtons,
			ResponseViewer,
			ModeSwitcher,
			WorkspacePanel
		},
		data() {
			return {
				url: '',
				method: 'GET',
				mobile: false, //是否是移动端
				isShow: false, //是否显示
				activeTab: 'params',
				tabMeta: {
					params: { title: '请求参数', description: '这些键值对与 URL 查询字符串双向同步；关闭一行即可暂时停用。' },
					headers: { title: '请求头', description: '设置发送给目标服务的 HTTP 请求头；敏感字段在分享前会提醒。' },
					body: { title: '请求体', description: '根据接口要求选择 JSON、表单、文本或其他请求体格式。' },
					auth: { title: '身份认证', description: '为当前请求配置 Basic 或 Bearer 认证信息。' },
					redirect: { title: '重定向策略', description: '控制是否跟随跳转以及单次请求允许的最大跳转次数。' }
				},
				redirectSettings: { followRedirects: true, maxRedirects: 5 },
				activeEnvironment: null,
				curlDialogVisible: false,
				curlInput: '',
				queryParams: {}, // 存储查询参数的对象
				buttons: {
					'headers': '请求头',
					'body': '请求体',
					'params': '参数'
				},
				display: 0, //展示方式
				latest: null, //接受请求体信息的对象
				recordSize: 380, //历史记录大小
				patt: URL_PATTERN, //URL正则 - 使用配置文件
				methods: [{
						value: 'GET',
						label: 'GET',
						type: 'success'
					},
					{
						value: 'POST',
						label: 'POST',
						type: 'primary'
					},
					{
						value: 'PUT',
						label: 'PUT',
						type: 'warning'
					},
					{
						value: 'DELETE',
						label: 'DELETE',
						type: 'danger'
					}, {
						value: 'PATCH',
						label: 'PATCH',
						type: 'default'
					},
					{
						value: 'HEAD',
						label: 'HEAD',
						type: 'info'
					},
				],
				tableData: {
					headers: [createEditorRow()],
					params: [createEditorRow()],
				},
				response: '',
				contentType: '',
				resHead: '',
				responseType: '', // New data field to store response type
				responseUrl: '', // New field to store URL for downloadable content
				responseFile: '',
				downloadUrl: '', // New field to store downloadable file URL
				isStreaming: false, // 标记当前是否为流媒体播放
				isLoading: false, // 请求加载中状态
				responseTime: 0, // 响应时间(毫秒)
				responseSize: 0, // 响应大小(字节)
				responseStatus: null,
				responseStatusText: '',
				responseFinalUrl: '',
				responseRedirectChain: [],
				responseContentType: '',
				responseDiagnosticsTruncated: false,
			};
		},
		mounted() {
			const route = useRoute();
			const router = useRouter();
			const that = this;
			const userAgent = navigator.userAgent || navigator.vendor || window.opera;
			// 检查是否为移动设备
			this.mobile = /iPhone|iPad|iPod|Android|BlackBerry|BB10|Silk|Mobi|Opera Mini|Windows Phone|webOS|UCBrowser/i
				.test(userAgent);

			this.recordSize = screen.availWidth - 30;

			router.isReady().then(() => {
				this.queryParams = route.query;
				this.url = decodeURIComponent(this.queryParams.url || '');
				this.method = (this.queryParams.method || 'GET').toUpperCase();
				this.tableData.headers = parseEditorRows(this.queryParams.headers);
				const sharedParams = parseEditorRows(this.queryParams.params);
				if (hasMeaningfulEditorRows(sharedParams)) {
					this.tableData.params = sharedParams;
					this.syncUrlFromParams();
				} else {
					this.syncParamsFromUrl(this.url);
				}
				this.redirectSettings = normalizeRedirectSettings({
					followRedirects: this.queryParams.followRedirects,
					maxRedirects: this.queryParams.maxRedirects
				});
				this.display = this.queryParams.display || 0;
				this.display === '1' ? this.$emit('update-message', false) : this.$emit('update-message', true);
				this.display === '1' ? this.isShow = false : this.isShow = true;
			});

			//watchEffect 监听 display
			watchEffect(() => {
				if (this.display && this.display != '0') {
					console.log('执行跳转');
					that.sendRequest();
				}
			});

		},
		methods: {
			queryHeaderNames(query, callback) {
				callback(filterHeaderSuggestions(query));
			},
			syncParamsFromUrl(value = this.url) {
				if (!String(value || '').trim()) {
					this.tableData.params = [createEditorRow()];
					return;
				}
				const rows = queryRowsFromUrl(value);
				if (rows) this.tableData.params = rows;
			},
			syncUrlFromParams() {
				try {
					this.url = replaceQueryRows(this.url, this.tableData.params);
				} catch {
					// URL 尚未输入完整或包含环境变量时，保留参数表，发送前再解析。
				}
			},
			handlePageKeydown(event) {
				if (event.key !== 'Enter' || (!event.ctrlKey && !event.metaKey) || event.repeat) return;
				event.preventDefault();
				this.sendRequest();
			},
			addRow(tab) {
				if (tab === 'body') return this.$refs.body?.addRow();
				if (this.tableData[tab]) this.tableData[tab].push(createEditorRow());
			},
			// 获取 ResponseViewer 组件的类型
			getViewerType() {
				// HEAD 请求特殊处理
				if (this.method.toUpperCase() === 'HEAD') {
					return 'head';
				}
				// 映射 responseType 到 ResponseViewer 的 type
				const typeMap = {
					'json': 'json',
					'text': 'text',
					'plain': 'text',
					'html': 'text',
					'xml': 'text',
					'javascript': 'text',
					'css': 'text',
					'image': 'image',
					'video': 'video',
					'audio': 'audio',
					'file': 'file'
				};
				return typeMap[this.responseType] || this.responseType;
			},
			removeRow(tab, index) {
				if (tab) {
					this.tableData[tab].splice(index, 1);
					if (tab === 'params') this.syncUrlFromParams();
				}
			},
			openCurlImport() {
				this.curlInput = '';
				this.curlDialogVisible = true;
			},
			applyCurlImport() {
				try {
					const imported = parseCurl(this.curlInput);
					this.method = imported.method;
					this.url = imported.url;
					this.syncParamsFromUrl(imported.url);
					this.tableData.headers = imported.headers;
					this.redirectSettings = normalizeRedirectSettings(imported.redirect, {
						followRedirects: false,
						maxRedirects: 5
					});
					this.$refs.userAuth?.applyDraft(imported.auth);
					this.$refs.body?.applyDraft(imported.body);
					this.activeTab = imported.body.type === 'none' ? 'headers' : 'body';
					this.curlDialogVisible = false;
					if (imported.warnings.length) ElMessage.warning(imported.warnings.join('；'));
					else ElMessage.success('cURL 已安全导入。');
				} catch (error) {
					ElMessage.error(error.message);
				}
			},
			getEditorDraft() {
				return {
					method: this.method,
					url: this.url,
					params: this.tableData.params,
					headers: this.tableData.headers,
					auth: this.$refs.userAuth?.getDraft() || { type: 'none' },
					redirect: { ...this.redirectSettings },
					body: supportsRequestBody(this.method)
						? (this.$refs.body?.getDraft() || { type: 'none' })
						: { type: 'none' }
				};
			},
			getResolvedRequestDraft() {
				const draft = resolveRequestDraft(this.getEditorDraft(), this.activeEnvironment);
				const preserveExistingWhenEmpty = queryRowsFromUrl(this.url) === null
					&& !hasMeaningfulEditorRows(this.tableData.params);
				return {
					...draft,
					url: replaceQueryRows(draft.url, draft.params, {
						stripHash: true,
						preserveExistingWhenEmpty
					})
				};
			},
			openWorkspace() {
				this.$refs.workspace?.open(this.getEditorDraft());
			},
			applySavedRequest(request) {
				this.method = request.method;
				this.url = request.url;
				this.tableData.params = normalizeEditorRows(request.params);
				if (hasMeaningfulEditorRows(this.tableData.params)) this.syncUrlFromParams();
				else this.syncParamsFromUrl(this.url);
				this.tableData.headers = normalizeEditorRows(request.headers);
				this.redirectSettings = normalizeRedirectSettings(request.redirect);
				this.$refs.userAuth?.applyDraft(request.auth);
				this.$refs.body?.applyDraft(request.body);
				this.activeTab = request.body?.type && request.body.type !== 'none' ? 'body' : 'params';
			},
			async copyAsCurl() {
				try {
					const editorDraft = this.getEditorDraft();
					const draft = this.getResolvedRequestDraft();
					if (!this.patt.test(draft.url)) throw new Error('请先输入可解析为 HTTP(S) 的请求 URL。');
					const command = exportCurl(draft);
					if (requestContainsSecrets(draft) || requestUsesSecretVariables(editorDraft, this.activeEnvironment)) {
						await ElMessageBox.confirm(
							'生成的 cURL 包含认证信息、敏感请求头或已解析的 Secret 环境变量，复制后请按密码对待。是否继续？',
							'敏感信息提醒',
							{ type: 'warning', confirmButtonText: '继续复制', cancelButtonText: '取消' }
						);
					}
					await navigator.clipboard.writeText(command);
					ElMessage.success('POSIX Shell cURL 已复制。');
				} catch (error) {
					if (error === 'cancel' || error === 'close') return;
					ElMessage.error(`复制 cURL 失败：${error.message || error}`);
				}
			},
			async copyApi() {
				try {
					const editorDraft = this.getEditorDraft();
					const resolvedDraft = this.getResolvedRequestDraft();
					if (!this.patt.test(resolvedDraft.url)) throw new Error('解析后的 URL 不是有效 HTTP(S) 地址。');
					const apiLink = buildDirectApiLink({
						apiBaseUrl: PROXY_CONFIG.API_BASE_URL,
						targetUrl: resolvedDraft.url,
						method: resolvedDraft.method,
						redirect: resolvedDraft.redirect
					});
					if (requestUsesSecretVariables({
						url: editorDraft.url,
						params: editorDraft.params
					}, this.activeEnvironment)) {
						await ElMessageBox.confirm(
							'API 链接会包含已展开的 Secret URL/Params 变量，并可能进入剪贴板或浏览器历史。是否继续？',
							'Secret URL 提醒',
							{ type: 'warning', confirmButtonText: '继续复制', cancelButtonText: '取消' }
						);
					}
					await this.copyLinkToClipboard(apiLink, '直达 API 链接已复制；访问后将直接返回 GET 响应。');
				} catch (error) {
					if (error === 'cancel' || error === 'close') return;
					ElMessage.error(error.message || String(error));
				}
			},
			copy(patt) {
				const editorDraft = this.getEditorDraft();
				if (!String(editorDraft.url || '').trim()) {
					if (patt !== 2) ElMessage.error('请先填写需要分享的请求 URL。');
					return '';
				}

				const pageLink = buildRequestPageLink({
					pageUrl: new URL(this.$router.resolve({ name: 'RequestForm' }).href, location.origin).href,
					draft: editorDraft
				});
				if (patt) {
					return pageLink;
				}
				this.copyLinkToClipboard(pageLink, 'API 请求页面链接已复制到剪切板！');
			},
			historyRecords() {
				this.$emit('update-message', false);
				this.$router.push('/history');
			},
			async copyLinkToClipboard(text, msg) {
				try {
					await navigator.clipboard.writeText(text);
					ElMessage.success(msg || '已复制到剪切板！');
				} catch (err) {
					ElMessage.error(`复制失败：${err.message}`);
					ElMessageBox.confirm(
							'链接复制失败，是否在新标签页直接打开该链接？',
							'温馨提示', {
								confirmButtonText: '跳转',
								cancelButtonText: '不跳转',
								type: 'warning',
							}
						)
						.then(() => {
							window.open(text, '_blank')
						})
						.catch((err) => {
							return ElMessage.error(`跳转失败：${err.message}`);
						})
				}
			},
			reader(data) {
				const reader = new FileReader();
				const that = this;
				reader.onload = function(event) {
					const result = event.target.result; // 读取结果
					if (that.display && that.display != '0') {
						document.open();
						document.write(result);
						document.close();
					} else {
						that.response = result;
					}
				};
				reader.readAsText(data);
			},
			getFileExtension(url) {
				// 使用正则表达式匹配最后一个点后的内容
				let match = url.match(/\.[0-9a-z]+$/i);
				if (match) {
					return match[0].substring(1); // 返回扩展名
				}
				return '';
			},
			// 检测是否为流媒体URL
			isMediaUrl(url) {
				const mediaExtensions = ['mp4', 'webm', 'ogg', 'mp3', 'wav', 'flac', 'aac', 'm4a', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'm3u8', 'ts'];
				const ext = this.getFileExtension(url).toLowerCase();
				return mediaExtensions.includes(ext);
			},
			// 获取媒体类型
			getMediaType(url) {
				const ext = this.getFileExtension(url).toLowerCase();
				const videoExts = ['mp4', 'webm', 'ogg', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'm3u8', 'ts'];
				const audioExts = ['mp3', 'wav', 'flac', 'aac', 'm4a'];
				if (videoExts.includes(ext)) return 'video';
				if (audioExts.includes(ext)) return 'audio';
				return null;
			},
			// 流媒体请求 - 直接设置src让浏览器处理流式加载
			streamRequest(proxyUrl, targetUrl) {
				const mediaType = this.getMediaType(targetUrl);
				if (mediaType === 'video') {
					this.responseType = 'video';
					this.responseUrl = proxyUrl;
					this.downloadUrl = proxyUrl;
					this.isStreaming = true;
					ElMessage.success('🎬 已启用流媒体播放模式，视频将边加载边播放');
				} else if (mediaType === 'audio') {
					this.responseType = 'audio';
					this.responseUrl = proxyUrl;
					this.downloadUrl = proxyUrl;
					this.isStreaming = true;
					ElMessage.success('🎵 已启用流媒体播放模式，音频将边加载边播放');
				}
			},
			// 子组件回传请求体信息
			onReceiveBody(payload) {
				this.latest = payload;
			},
			resetResponseDiagnostics() {
				this.responseTime = 0;
				this.responseSize = 0;
				this.responseStatus = null;
				this.responseStatusText = '';
				this.responseFinalUrl = '';
				this.responseRedirectChain = [];
				this.responseContentType = '';
				this.responseDiagnosticsTruncated = false;
			},
			captureResponseDiagnostics(res, fallbackUrl, startTime) {
				const diagnostics = parseResponseDiagnostics(res.headers, fallbackUrl);
				this.responseStatus = res.status;
				this.responseStatusText = res.statusText || '';
				this.responseFinalUrl = diagnostics.finalUrl;
				this.responseRedirectChain = diagnostics.redirectChain;
				this.responseDiagnosticsTruncated = diagnostics.truncated;
				this.responseContentType = res.headers['content-type'] || '';
				this.responseTime = elapsedMilliseconds(startTime, performance.now());
				this.responseSize = responseByteLength(res.data);
				this.resHead = res.headers;
			},
			async sendRequest() {
				const display = this.display; //数据展示方式，0为响应内容部分展示，1为跳转新页面展示
				let resolvedDraft;
				let requestUrl;
				try {
					resolvedDraft = this.getResolvedRequestDraft();
					requestUrl = resolvedDraft.url;
					if (!this.patt.test(requestUrl)) throw new Error('解析后的 URL 不是有效 HTTP(S) 地址。');
					this.latest = supportsRequestBody(resolvedDraft.method)
						? buildRequestBody(resolvedDraft.body)
						: { body: null, contentType: '', mode: 'none' };
				} catch (error) {
					return ElMessage.error(error.message || '请检查请求 URL、Body 和环境变量。');
				}

				const headers = [];
				let upstreamAuthorization = display ? '' : buildAuthorizationHeader(resolvedDraft.auth);

				for (const obj of activeEditorRows(resolvedDraft.headers)) {
					if (obj?.key) {
						if (obj.key.toLowerCase() === 'authorization') {
							upstreamAuthorization = obj.value || '';
						} else {
							headers.push({ key: obj.key, value: obj.value });
						}
					}
				}

				const finHeaders = editorRowsToHeaders(headers);
				if (this.latest?.mode === 'multipart') {
					Object.keys(finHeaders).forEach((name) => {
						if (name.toLowerCase() === 'content-type') delete finHeaders[name];
					});
				}

				const proxyTransport = buildProxyTransport(
					PROXY_CONFIG.BASE_URL,
					requestUrl,
					finHeaders,
					upstreamAuthorization
				);
				if (proxyTransport.ignoredHeaders.length) {
					ElMessage.warning(`以下请求头格式无效或不允许由客户端指定，已忽略：${proxyTransport.ignoredHeaders.join('、')}`);
				}
				const finReqUrl = applyRedirectSettings(proxyTransport.url, resolvedDraft.redirect);

				const records = JSON.parse(localStorage.getItem('history') || "[]");
				const date = new Date();
				const time =
					`${date.getFullYear()}.${date.getMonth()+1}.${date.getDate()} ${date.getHours()}:${date.getMinutes()}:${date.getSeconds()}`;
				const newRecords = [{
					"date": time,
					"url": this.copy(2)
				}].concat(records);
				localStorage.setItem('history', JSON.stringify(newRecords));

				//withCredentials: true表示携带Cookie
				const config = {
					method: this.method.toUpperCase(),
					url: finReqUrl,
					withCredentials: true,
					headers: proxyTransport.headers,
					validateStatus: () => true
				};

				// 根据请求方法设置请求体信息
				if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(this.method.toUpperCase())) {
					if (this.latest && this.latest.mode !== 'none') {
						config.data = this.latest.body;
						if (this.latest.contentType) {
							config.headers = config.headers || {};
							config.headers['Content-Type'] = this.latest.contentType;
						}
					}
				}

				// 🎬 流媒体模式：对于视频/音频，直接设置src让浏览器流式加载
				this.resetResponseDiagnostics();
				if (this.method.toUpperCase() === 'GET' && this.isMediaUrl(requestUrl) && Object.keys(config.headers).length === 0) {
					console.log('[Streaming] 检测到流媒体URL，启用流媒体模式');
					this.streamRequest(finReqUrl, requestUrl);
					return;
				}

				// 设置响应类型
				const isBinary = this.method.toUpperCase() === 'GET'; // 假设只在 GET 请求时访问二进制资源

				if (isBinary) {
					config.responseType = 'blob'; // 设置为 blob 以处理二进制数据
				}

				// 非流媒体模式，重置标记
				this.isStreaming = false;
				
				// 设置加载状态
				this.isLoading = true;
				const startTime = performance.now();

				try {
					const res = await axios(config);
					
					this.captureResponseDiagnostics(res, requestUrl, startTime);
					
					if (isBinary) {
						this.handleResponse(res, display);
					} else {
						// 如果是对象则格式化，如果是字符串则直接显示（修复 HTML 被 JSON.stringify 包裹的问题）
						this.response = (typeof res.data === 'object') ? JSON.stringify(res.data, null, 2) : res.data;
						
						this.responseType = res.headers['content-type']?.split(';')[0].split('/')[1] || 'json';
						if (display && display != '0') {
							document.open();
							document.write(this.method.toUpperCase() === 'HEAD' ? JSON.stringify(this.resHead) : this.response);
							document.close();
						}
						// 修复：下载内容应该是响应体 res.data (或 stringified)，而不是响应头 resHead
						// 特例：HEAD 请求响应体为空，下载时我们希望下载响应头信息
						let blobContent;
						if (this.method.toUpperCase() === 'HEAD') {
							blobContent = JSON.stringify(this.resHead, null, 2);
						} else {
							blobContent = (typeof res.data === 'object') ? JSON.stringify(res.data, null, 2) : res.data;
						}
						
						const blob = new Blob([blobContent], {
							"type": res.headers['content-type'] || "text/plain"
						});
						this.downloadUrl = URL.createObjectURL(blob);
					}
				} catch (err) {
					if (this.responseStatus === null) {
						this.responseTime = elapsedMilliseconds(startTime, performance.now());
					}
					// 使用错误处理工具解析错误
					const errorInfo = parseError(err);
					
					if (err.response?.data && err.response?.data instanceof Blob) {
						console.log('错误信息是blob对象');
						this.reader(err.response.data);
					} else {
						// 显示更详细的错误信息
						this.response = `\u274c 请求失败\n\n错误信息：${errorInfo.message}${errorInfo.details ? `\n详细信息：${errorInfo.details}` : ''}`;
						this.responseType = 'text';
					}
					
					// 根据错误类型显示不同的提示
					if (errorInfo.type === 'warning') {
						ElMessage.warning(errorInfo.message);
					} else {
						ElMessage.error(errorInfo.message);
					}
				} finally {
					// 无论成功还是失败，都重置加载状态
					this.isLoading = false;
				}
			},
			handleResponse(response, display) {
				const contentType = response.headers['content-type'] || 'text/plain;charset=utf-8';
				this.contentType = contentType;
				const blob = new Blob([response.data], {
					type: contentType
				});
				const objectUrl = URL.createObjectURL(blob);

				if (contentType.includes('image')) {
					this.responseType = 'image';
					display && display != '0' ? location.href = objectUrl : true;
					this.responseUrl = objectUrl;
					this.downloadUrl = objectUrl;
				} else if (contentType.includes('video')) {
					this.responseType = 'video';
					display && display != '0' ? location.href = objectUrl : true;
					this.responseUrl = objectUrl;
					this.downloadUrl = objectUrl;
				} else if (contentType === 'audio/mpegurl' || contentType === 'application/vnd.apple.mpegurl') {
					//m3u8文件
					this.responseType = 'text';
					this.reader(response.data);
					this.downloadUrl = objectUrl;
				} else if (contentType.includes('audio')) {
					this.responseType = 'audio';
					display && display != '0' ? location.href = objectUrl : true;
					this.responseUrl = objectUrl;
					this.downloadUrl = objectUrl;
				} else if (
					contentType.includes('application/octet-stream') ||
					contentType.includes('application/zip')
				) {
					this.responseType = 'file';
					display && display != '0' ? location.href = objectUrl : true;
					this.responseUrl = objectUrl;
					this.downloadUrl = objectUrl; // 设置为可下载 URL
					this.responseFile = 'file.' + this.getFileExtension(this.responseFinalUrl || this.url); //设置下载文件名
				} else if (contentType.includes('application/json')) {
					this.responseType = 'json';
					this.reader(response.data);
					this.downloadUrl = objectUrl;
				} else {
					this.responseType = 'text';
					this.reader(response.data);
					this.downloadUrl = objectUrl;
				}
			},
			downloadResponse() {
				const link = document.createElement('a');
				link.style.display = 'none';
				link.href = this.downloadUrl;
				// 根据响应类型设置下载文件名（默认后缀为txt）
				let fileName;
				if (this.contentType === 'application/octet-stream') {
					fileName = 'file.' + this.getFileExtension(this.url); //获取URL请求文件后缀
				} else if (this.contentType === 'audio/mpegurl' || this.contentType === 'application/vnd.apple.mpegurl') {
					fileName = 'file.m3u8';
				} else {
					const mimeType = this.contentType.split(';')[0];
					const extMap = {
						'application/javascript': 'js',
						'text/javascript': 'js',
						'application/json': 'json',
						'text/html': 'html',
						'text/css': 'css',
						'text/plain': 'txt',
						'text/xml': 'xml',
						'application/xml': 'xml',
						'image/jpeg': 'jpg',
						'image/png': 'png',
						'image/gif': 'gif',
						'image/webp': 'webp'
					};
					const ext = extMap[mimeType] || mimeType.split('/')[1] || 'txt';
					fileName = `response.${ext}`;
				}
				link.download = fileName; // 设置下载文件名
				document.body.appendChild(link);
				link.click(); // 执行下载
				document.body.removeChild(link);
				//URL.revokeObjectURL(this.downloadUrl); // 释放临时 URL（添加这一行移动端取消下载再次尝试下载会失效）
			},
		},
	};
</script>

<style scoped>
	/* 主容器 */
	.container {
		display: flex;
		flex-direction: row;
	}

	.item {
		margin: 10px;
	}

	.redirect-settings {
		max-width: 720px;
		display: grid;
		gap: 12px;
	}

	.el-row {
		margin-bottom: 12px;
	}

	.el-row:last-child {
		margin-bottom: 0;
	}

	/* 代码块 */
	pre {
		background: #f5f5f5;
		padding: 12px;
		border-radius: 8px;
		white-space: pre-wrap;
		word-break: break-word;
	}

	/* 返回顶部按钮 */
	.backup {
		height: 100%;
		width: 100%;
		background: linear-gradient(135deg, #409eff 0%, #67c23a 100%);
		border-radius: 50%;
		box-shadow: 0 4px 12px rgba(64, 158, 255, 0.4);
		text-align: center;
		line-height: 40px;
		color: white;
		transition: all 0.3s ease;
	}

	.backup:hover {
		transform: scale(1.1);
		box-shadow: 0 6px 20px rgba(64, 158, 255, 0.6);
	}

	/* 旧版按钮组样式保留兼容 */
	.button-group {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	.button-item {
		width: 100%;
		margin-bottom: 10px;
	}

	.el-button+.el-button {
		margin-left: 0px;
	}

	/* 卡片样式优化 */
	:deep(.el-card) {
		border-radius: 12px;
		box-shadow: 0 2px 12px rgba(0, 0, 0, 0.08);
		transition: box-shadow 0.3s ease;
	}

	:deep(.el-card:hover) {
		box-shadow: 0 4px 20px rgba(0, 0, 0, 0.12);
	}

	/* 输入框优化 */
	:deep(.el-input__wrapper) {
		border-radius: 8px;
	}

	:deep(.el-select .el-input__wrapper) {
		border-radius: 8px;
	}

	/* 表格优化 */
	:deep(.el-table) {
		border-radius: 8px;
		overflow: hidden;
	}

	:deep(.el-table th) {
		background: #f5f7fa !important;
	}

	/* 移动端适配 */
	@media (max-width: 768px) {
		.button-item {
			width: 100%;
			margin-bottom: 8px;
		}

		:deep(.el-input) {
			font-size: 16px; /* 防止 iOS 缩放 */
		}

		:deep(.el-select) {
			width: 100% !important;
		}

		:deep(.el-card) {
			border-radius: 8px;
			margin-left: -5px;
			margin-right: -5px;
		}

		:deep(.el-card__body) {
			padding: 12px;
		}

		:deep(.el-table) {
			font-size: 13px;
		}

		:deep(.el-button) {
			padding: 10px 16px;
			min-height: 44px; /* iOS 触摸目标最小尺寸 */
		}
	}

	/* 平板适配 */
	@media (min-width: 769px) and (max-width: 1024px) {
		.button-item {
			width: auto;
			margin-bottom: 0;
		}

		:deep(.el-card__body) {
			padding: 16px;
		}
	}

	/* 大屏适配 */
	@media (min-width: 768px) {
		.button-item {
			width: auto;
			margin-bottom: 0;
		}
	}

	/* 动画 */
	.el-card {
		animation: fadeInUp 0.3s ease;
	}

	@keyframes fadeInUp {
		from {
			opacity: 0;
			transform: translateY(10px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	/* API 工作台 */
	.api-page {
		width: min(1180px, calc(100% - 40px));
		min-height: calc(100vh - 70px);
		margin: 0 auto;
		padding: 24px 0 34px;
		text-align: left;
	}

	.page-hero {
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		gap: 24px;
		margin-bottom: 18px;
		padding: 18px 4px 4px;
	}

	.eyebrow {
		color: #1677ff;
		font-size: 11px;
		font-weight: 800;
		letter-spacing: 0.16em;
	}

	.page-hero h1 {
		margin: 6px 0 7px;
		font-size: clamp(28px, 4vw, 38px);
		letter-spacing: -0.04em;
	}

	.page-hero p {
		max-width: 700px;
		margin: 0;
		color: #667085;
		line-height: 1.7;
	}

	.environment-status {
		display: flex;
		align-items: center;
		gap: 10px;
		min-width: 285px;
		padding: 11px 10px 11px 15px;
		border: 1px solid #dce7f5;
		border-radius: 13px;
		background: #f8fbff;
	}

	.environment-status .status-dot {
		flex: 0 0 9px;
		width: 9px;
		height: 9px;
		border-radius: 50%;
		background: #24a148;
		box-shadow: 0 0 0 5px rgba(36, 161, 72, 0.1);
	}

	.environment-status > div { display: grid; flex: 1; gap: 2px; }
	.environment-status strong { font-size: 13px; }
	.environment-status small { color: #7b8798; font-size: 11px; }

	.request-composer {
		margin-bottom: 14px;
		padding: 14px;
		border: 1px solid #dfe6ef;
		border-radius: 15px;
		background: #fff;
		box-shadow: 0 9px 28px rgba(31, 45, 61, 0.06);
	}

	.request-line {
		display: grid;
		grid-template-columns: 132px minmax(0, 1fr) 132px;
		gap: 10px;
	}

	.method-select { width: 100%; }
	.method-option { display: flex; align-items: center; gap: 9px; font-weight: 700; }
	.method-dot { width: 8px; height: 8px; border-radius: 50%; background: #8a94a6; }
	.method-dot.success { background: #24a148; }
	.method-dot.primary { background: #1677ff; }
	.method-dot.warning { background: #e88900; }
	.method-dot.danger { background: #d92d20; }

	.composer-help {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		margin-top: 10px;
		color: #8a94a6;
		font-size: 11px;
	}

	.composer-help > div { display: flex; align-items: center; gap: 5px; white-space: nowrap; }
	.composer-help kbd { padding: 2px 5px; border: 1px solid #d8dee8; border-bottom-width: 2px; border-radius: 5px; background: #f8fafc; font-family: inherit; }

	.request-editor-card {
		border-color: #e4eaf2;
		border-radius: 15px !important;
		box-shadow: none !important;
	}

	.request-editor-card:hover { box-shadow: none !important; }
	.editor-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; }
	.editor-heading > div { display: grid; gap: 4px; }
	.editor-heading strong { font-size: 16px; }
	.editor-heading span { color: #7b8798; font-size: 12px; line-height: 1.5; }
	.editor-table { width: 100%; margin-bottom: 4px; }
	.header-name-autocomplete { width: 100%; }
	.header-suggestion { display: grid; gap: 2px; padding: 5px 0; line-height: 1.35; }
	.header-suggestion strong { color: var(--el-text-color-primary); font-size: 13px; }
	.header-suggestion span { overflow: hidden; color: var(--el-text-color-secondary); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
	.header-proxy-tip { margin-bottom: 12px; }
	.redirect-settings { max-width: none; }
	.redirect-grid { display: grid; grid-template-columns: minmax(240px, 1fr) minmax(180px, 1fr); gap: 18px; max-width: 620px; }
	.boolean-select { width: 100%; }
	.curl-input { margin-top: 14px; }

	.api-page > .el-row { margin-bottom: 14px !important; }

	@media (max-width: 760px) {
		.api-page { width: min(100% - 24px, 1180px); padding-top: 12px; }
		.page-hero { align-items: flex-start; flex-direction: column; gap: 14px; padding-top: 10px; }
		.environment-status { width: 100%; min-width: 0; }
		.request-line { grid-template-columns: 110px minmax(0, 1fr); }
		.send-button { grid-column: 1 / -1; width: 100%; }
		.composer-help { align-items: flex-start; flex-direction: column; gap: 7px; }
		.redirect-grid { grid-template-columns: 1fr; gap: 0; }
		.request-editor-card { margin: 0 !important; }
	}

	@media (max-width: 480px) {
		.request-line { grid-template-columns: 1fr; }
		.method-select,
		.send-button { grid-column: 1; }
		.request-composer { padding: 11px; }
	}
</style>
