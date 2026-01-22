<template>
	<el-container v-if="isShow" @keydown.enter="sendRequest">
		<el-header style="color:#409EFF;font-size: 40px" height="75px">
			<el-row>
				<el-col :span="24">
					在线代理网站
				</el-col>
			</el-row>
		</el-header>
		<el-main>

			<!-- 移动端第一行: 请求方法、API URL 和发送按钮 -->
			<!-- 移动端第一行: 请求方法、API URL 和发送按钮 (分行显示) -->
			<div v-if="mobile" style="margin-bottom: 20px;">
				<el-select v-model="method" placeholder="Request Method" style="width: 100%; margin-bottom: 10px;"
					@change="method != 'GET' && method != 'HEAD' ? activeTab = 'body' : activeTab = 'params'">
					<el-option v-for="option in methods" :key="option.value" :label="option.label"
						:value="option.value">
						<template #default>
							<el-tag :type="option.type" style="width: 100%; text-align: center;">{{ option.label }}</el-tag>
						</template>
					</el-option>
				</el-select>
				
				<el-input v-model="url" placeholder="Enter API URL" clearable style="margin-bottom: 10px;" />
				
				<el-button type="primary" @click="sendRequest" style="width: 100%;">
					<el-icon class="el-icon--left"><Search /></el-icon>
					发送请求
				</el-button>
			</div>

			<!-- PC端第一行: 请求方法、API URL 和发送按钮 -->
			<el-row :gutter="10" style="margin-bottom: 20px;" v-if="!mobile">
				<el-col :span="6">
					<el-select v-model="method" placeholder="请求方法" style="width: 100%;"
						@change="method != 'GET' && method != 'HEAD' ? activeTab = 'body' : activeTab = 'params'">
						<el-option v-for="option in methods" :key="option.value" :label="option.label"
							:value="option.value">
							<template #default>
								<el-tag :type="option.type"
									style="width: 100%; text-align: center;">{{ option.label }}</el-tag>
							</template>
						</el-option>
					</el-select>
				</el-col>
				<el-col :span="12">
					<el-input v-model="url" clearable placeholder="Enter API URL" />
				</el-col>
				<el-col :span="1" justify="start">
					<el-button type="primary" @click="sendRequest" block><el-icon class="el-icon--left">
							<Search />
						</el-icon>发送请求</el-button>
				</el-col>
			</el-row>

			<!-- 第二行: 操作按钮区 -->
			<el-row :gutter="10" style="margin-bottom: 20px;">
				<el-col :span="24">
					<ActionButtons
						:method="method"
						:showDownload="!!downloadUrl"
						@switch-tab="activeTab = $event"
						@add-row="addRow(activeTab)"
						@copy-page="copy(0)"
						@copy-api="copy(1)"
						@download="downloadResponse"
						@history="historyRecords"
					/>
				</el-col>
			</el-row>

			<el-card>
				<!-- 请求体 -->
				<RequestBody v-show="activeTab === 'body'" @submit-payload="onReceiveBody" ref="body" />

				<!-- 用户验证 -->
				<UserAuth v-show="activeTab === 'auth'" @userAuth="handleAuth" ref="userAuth" />

				<!-- 动态表格 -->
				<el-table v-if="activeTab && activeTab != 'auth' && activeTab != 'body'" :data="tableData[activeTab]"
					style="margin-bottom: 20px;">
					<el-table-column prop="key" :label="'Key（'+buttons[activeTab]+')'">
						<template #default="scope">
							<el-input v-model="scope.row.key" clearable />
						</template>
					</el-table-column>
					<el-table-column prop="value" :label="'Value（'+buttons[activeTab]+')'">
						<template #default="scope">
							<el-input v-model="scope.row.value" clearable />
						</template>
					</el-table-column>
					<el-table-column :label="'操作（'+buttons[activeTab]+')'">
						<template #default="{ $index }">
							<el-button type="danger" @click="removeRow(activeTab, $index)"><el-icon
									class="el-icon--left">
									<Delete />
								</el-icon>删除</el-button>
						</template>
					</el-table-column>
				</el-table>
			</el-card>

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
			/>

			<!-- 返回顶部 -->
			<el-backtop :bottom="100">
				<div class="backup">
					<el-icon>
						<Top />
					</el-icon>
				</div>
			</el-backtop>

		</el-main>
	</el-container>
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

	import UserAuth from './UserAuth.vue';
	import RequestBody from './RequestBody.vue';
	import ActionButtons from './ActionButtons.vue';
	import ResponseViewer from './ResponseViewer.vue';
	export default {
		name: 'RequestForm',
		components: {
			UserAuth,
			RequestBody,
			ActionButtons,
			ResponseViewer
		},
		data() {
			return {
				url: '',
				method: 'GET',
				mobile: false, //是否是移动端
				isShow: false, //是否显示
				activeTab: 'params',
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
					headers: [{
						key: '',
						value: ''
					}],
					params: [{
						key: '',
						value: ''
					}],
				},
				auth: '',
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
				console.log(JSON.stringify(this.queryParams));
				this.url = decodeURIComponent(this.queryParams.url || '');
				this.method = (this.queryParams.method || 'GET').toUpperCase();
				this.tableData.headers = JSON.parse(this.queryParams.headers || "[{}]");
				this.tableData.params = JSON.parse(this.queryParams.params || "[{}]");
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
			addRow(tab) {
				if (tab) {
					this.tableData[tab].push({
						key: '',
						value: ''
					});
				}
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
				}
			},
			handleSearch(originArr) {
				let resultArr = [];
				originArr.forEach((value) => {
					console.log(value);
					value.key ? resultArr.push({
						"key": value.key,
						"value": value.value
					}) : true
				});
				JSON.stringify(resultArr) === JSON.stringify([]) ? resultArr = '' : resultArr = JSON.stringify(resultArr);
				return resultArr;
			},
			copy(patt) {

				if (!this.patt.test(this.url)) {
					return ElMessage.error('请检查请求URL是否为空或格式有误！');
				}

				const that = this;
				if (!this.display) {
					this.$refs.userAuth.handle();
				}
				if (patt == 1) {
					// 复制API接口
					const apiUrl = new URL(location.origin);
					const nowUrl = new URL(that.url);
					const urlParams = nowUrl.searchParams;
					const queryString = that.tableData.params;
					for (let obj of queryString) {
						console.log(obj);
						if (Object.keys(obj).toString() === 'key,value' && Object.values(obj)[0] != '') {
							urlParams.append(obj.key, obj.value);
						}
					}
					apiUrl.searchParams.append('url', `${nowUrl.origin}${nowUrl.pathname}?${urlParams.toString()}`);
					apiUrl.searchParams.append('method', that.method);

					let finHeaders = {};

					// 处理子组件Auth请求头内容（注意：手动在设置请求头中Auth优先级最高）
					this.auth ? finHeaders['authorization'] = this.auth : true;

					that.tableData.headers.forEach((value) => {
						value.key ? finHeaders[value.key] = value.value : true
					});
					apiUrl.searchParams.append('headers', JSON.stringify(finHeaders));

					return that.copyLinkToClipboard(apiUrl.href, '当前配置API接口已复制到剪切板！');
				}

				// 下面为复制页面链接
				const url = new URL(location.origin + location.pathname);
				url.searchParams.append('url', this.url);

				// 处理子组件Auth请求头内容（注意：手动在设置请求头中Auth优先级最高）
				let array = [];
				let result = false;

				this.tableData.headers.forEach((value) => {
					if (value.key?.toLowerCase() === 'authorization' && value.value) {
						result = true;
						array.push(value);
					} else if (value.value) {
						array.push(value);
					}
				});

				this.$refs.userAuth.handle();

				if (!result && this.auth) {
					array.push({
						key: "authorization",
						value: this.auth
					})
				}

				url.searchParams.append('headers', this.handleSearch(array));
				url.searchParams.append('method', this.method);
				url.searchParams.append('params', this.handleSearch(this.tableData.params));
				url.searchParams.append('display', 0);
				console.log(`完整URL：${url.href}`);
				if (patt) {
					return url.href;
				}
				this.copyLinkToClipboard(url.href, '当前配置页面链接已复制到剪切板！');
			},
			handleAuth(value) {
				this.auth = value;
			},
			historyRecords() {
				this.$emit('update-message', false);
				this.$router.push('/web/history');
			},
			async copyLinkToClipboard(text, msg) {
				try {
					await navigator.clipboard.writeText(text);
					ElMessage.success(msg || '已复制到剪切板！');
				} catch (err) {
					ElMessage.error(`复制失败：${err.message}`);
					ElMessageBox.confirm(
							'链接复制失败，是否跳转以获取当前配置API链接？',
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
			streamRequest(proxyUrl) {
				const mediaType = this.getMediaType(this.url);
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
			async sendRequest() {
				console.log(`查询字符串内容：${JSON.stringify(this.tableData.params)}`);
				const display = this.display; //数据展示方式，0为响应内容部分展示，1为跳转新页面展示

				if (!this.patt.test(this.url)) {
					return ElMessage.error('请检查请求URL格式是否有误！');
				}

				const nowUrl = new URL(this.url);
				const urlParams = nowUrl.searchParams;
				const queryString = this.tableData.params;
				let headers = [];

				// 处理子组件Auth请求头内容
				if (!display) {
					this.$refs.userAuth.handle();
					this.auth ? headers.push({
						"key": "authorization",
						"value": this.auth
					}) : true;
				}


				// 处理自定义Cookie，因Cookie无法手动修改，通过document.cookie将Cookie写入客户端
				for (let obj of this.tableData.headers) {
					// 末尾添加“;domain=;path=/;”使得Cookie在当前域名和根目录下生效
					if (obj && obj.key) { // 确保 obj 和 obj.key 存在
						if (obj.key.toUpperCase() === 'COOKIE' || obj.key.toUpperCase() === 'COOKIES') {
							document.cookie = obj.value + ';domain=;path=/;';
						} else {
							headers.push({
								"key": obj.key,
								"value": obj.value
							});
						}
					}
				}

				for (let obj of queryString) {
					console.log(obj);
					if (Object.keys(obj).toString() === 'key,value' && Object.values(obj)[0] != '') {
						urlParams.append(obj.key, obj.value);
					}
				}

				let requestUrl;

				if (urlParams.toString()) {
					requestUrl = `${nowUrl.origin}${nowUrl.pathname}?${urlParams.toString()}`;
				} else {
					requestUrl = nowUrl;
				}


				let finHeaders = {};

				headers.forEach((value) => {
					value.key ? finHeaders[value.key] = value.value : true
				});

				const finReqUrl = `${PROXY_CONFIG.BASE_URL}/?url=${encodeURIComponent(requestUrl)}&headers=${encodeURIComponent(JSON.stringify(finHeaders))}`;

				console.log(`最终请求URL：${finReqUrl}`);

				const records = JSON.parse(localStorage.getItem('history') || "[]");
				const date = new Date();
				const time =
					`${date.getFullYear()}.${date.getMonth()+1}.${date.getDate()} ${date.getHours()}:${date.getMinutes()}:${date.getSeconds()}`;
				const newRecords = [{
					"date": time,
					"url": decodeURIComponent(this.copy(2))
				}].concat(records);
				localStorage.setItem('history', JSON.stringify(newRecords));

				//withCredentials: true表示携带Cookie
				const config = {
					method: this.method.toUpperCase(),
					url: finReqUrl,
					withCredentials: true
				};

				// 根据请求方法设置请求体信息
				if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(this.method.toUpperCase())) {
					// 从子组件获取请求体信息
					this.latest = null;
					this.$refs.body.buildAndEmit();
					if (this.latest) {
						config.data = this.latest.body;
						config.headers = config.headers || {};
						config.headers['Content-Type'] = this.latest.contentType;
					}
				}

				// 🎬 流媒体模式：对于视频/音频，直接设置src让浏览器流式加载
				if (this.method.toUpperCase() === 'GET' && this.isMediaUrl(this.url)) {
					console.log('[Streaming] 检测到流媒体URL，启用流媒体模式');
					this.streamRequest(finReqUrl);
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
				this.responseTime = 0;
				this.responseSize = 0;
				const startTime = Date.now();

				console.log(JSON.stringify(config));

				try {
					const res = await axios(config);
					
					// 记录响应时间
					this.responseTime = Date.now() - startTime;
					
					if (isBinary) {
						// 记录响应大小
						this.responseSize = res.data?.size || 0;
						this.handleResponse(res, display);
					} else {
						// 记录响应大小
						// 记录响应大小
						this.responseSize = (typeof res.data === 'object') ? JSON.stringify(res.data).length : res.data.length;
						
						this.resHead = res.headers;
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
					console.log(`错误信息：${JSON.stringify(err.response)}`);
					
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
				const contentType = response.headers['content-type'];
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
					this.responseFile = 'file.' + this.getFileExtension(this.url); //设置下载文件名
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
</style>