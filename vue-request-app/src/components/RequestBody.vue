<template>
	<div class="box-card">
		<div class="clearfix">
			<slot name="header"></slot>
		</div>


		<!-- 构建并传给父页面（emit）：buildAndEmit-->
		<el-form :model="state" label-width="auto">
			<el-form-item label="传输方式">
				<el-radio-group v-model="state.mode">
					<el-radio-button label="kv">键值对</el-radio-button>
					<el-radio-button label="file">上传文件</el-radio-button>
					<el-radio-button label="json">JSON 数据</el-radio-button>
					<el-radio-button label="text">纯文本</el-radio-button>
					<el-button style="margin-left:20px" type="primary" @click="addRow">新增一行</el-button>
					<el-button type="warning" @click="resetAll">重置</el-button>
				</el-radio-group>
			</el-form-item>

			<!-- Key-Value Editor -->
			<div v-if="state.mode === 'kv'">
				<el-table :data="kvRows" style="width: 100%" size="small" border>
					<el-table-column prop="key" label="Key" width="260">
						<template #default="{ row }">
							<el-input v-model="row.key" placeholder="参数名"></el-input>
						</template>
					</el-table-column>
					<el-table-column prop="value" label="Value">
						<template #default="{ row }">
							<el-input v-model="row.value" placeholder="参数值"></el-input>
						</template>
					</el-table-column>
					<el-table-column label="操作" width="120">
						<template #default="{ $index }">
							<el-button type="danger" size="mini" @click="removeRow($index)">删除</el-button>
						</template>
					</el-table-column>
				</el-table>
			</div>

			<!-- File Upload -->
			<div v-if="state.mode === 'file'" style="margin-top: 8px;">
				<el-upload ref="uploadRef" v-model:file-list="fileList" :auto-upload="false" multiple drag>
					<i class="el-icon-upload"></i>
					<div class="el-upload__text">将文件拖到此处或<em>点击上传</em></div>
				</el-upload>
				<div style="margin-top:8px">
					<el-input v-model="fileFieldName" placeholder="表单中文件字段名（默认: files）"></el-input>
				</div>
			</div>

			<!-- JSON Editor -->
			<div v-if="state.mode === 'json'" style="margin-top: 8px;">
				<el-input type="textarea" :rows="8" v-model="jsonText"
					placeholder='输入合法的 JSON，例如: {"name":"张三"}'></el-input>
				<div style="margin-top:8px">
					<el-button @click="formatJson">格式化</el-button>
					<el-button @click="clearJson">清空</el-button>
					<el-tag :type="jsonValid ? 'success' : 'danger'" size="large"
						style="margin-left:10px">{{ jsonValid ? 'JSON 合法' : 'JSON 非法' }}</el-tag>
				</div>
			</div>

			<!-- Plain Text -->
			<div v-if="state.mode === 'text'" style="margin-top: 8px;">
				<el-input type="textarea" :rows="6" v-model="plainText" placeholder="请输入要作为纯文本发送的内容"></el-input>
			</div>

		</el-form>
	</div>
</template>

<script>
	import {
		ElMessage
	} from 'element-plus';
	export default {
		name: 'RequestBody',
		emits: ["submit-payload"],
		data() {
			return {
				// 状态
				state: {
					mode: "kv",
				},
				// 各模式需要的值
				plainText: "",
				previewText: "",
				jsonText: "",
				fileList: [],
				kvRows: [{
					key: "",
					value: ""
				}],
				fileFieldName: ""
			};
		},
		computed: {
			// 如果你有 jsonValid 的完整逻辑，可以放这里
			jsonValid() {
				if (!this.jsonText) return false
				try {
					JSON.parse(this.jsonText)
					return true
				} catch {
					return false
				}
			}
		},
		methods: {
			// ------- Key Value -------
			addRow() {
				this.kvRows.push({
					key: '',
					value: ''
				})
			},
			removeRow(index) {
				this.kvRows.splice(index, 1)
			},
			clearRows() {
				this.kvRows = [{
					key: '',
					value: ''
				}]
			},
			// ------- 格式化JSON -------
			formatJson() {
				try {
					const parsed = JSON.parse(this.jsonText);
					this.jsonText = JSON.stringify(parsed, null, 2);
					ElMessage.success('JSON数据已格式化！');
				} catch {
					ElMessage.error('JSON 语法错误！');
				}
			},
			clearJson() {
				this.jsonText = ''
			},
			/** 构建 payload */
			buildPayload() {
				let body = null;
				let contentType = "";
				const mode = this.state.mode;

				if (mode === "kv") {
					const params = new URLSearchParams();
					this.kvRows.forEach((r) => {
						if (r.key) params.append(r.key, r.value);
					});

					body = params;
					contentType = "application/x-www-form-urlencoded;charset=utf-8";

				} else if (mode === "file") {
					const fd = new FormData();
					this.fileList.forEach((f) => {
						const raw = f.raw || f.file;
						if (raw) fd.append(this.fileFieldName || "files", raw);
					});
					body = fd;
					contentType = ""; // 浏览器自己处理 multipart

				} else if (mode === "json") {
					if (!this.jsonValid) throw new Error("JSON 无效");
					body = this.jsonText;
					contentType = "application/json;charset=utf-8";

				} else if (mode === "text") {
					body = this.plainText;
					contentType = "text/plain;charset=utf-8";
				}

				return {
					body,
					contentType,
					mode
				};
			},
			/** 构建并 emit 给父组件 */
			buildAndEmit() {
				try {
					const payload = this.buildPayload();
					this.$emit("submit-payload", payload);
				} catch (e) {
					ElMessage.error(e.message);
				}
			},
			/** 重置所有内容 */
			resetAll() {
				this.state.mode = "kv";
				this.kvRows = [{
					key: "",
					value: ""
				}];
				this.fileList = [];
				this.jsonText = "";
				this.plainText = "";
				this.previewText = "";
				this.fileFieldName = "";
			}
		}
	};
</script>

<style scoped>
	.box-card {
		width: 100%;
		margin: 12px auto
	}
</style>