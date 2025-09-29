# Tencent Cloud TRTC-AI TTS Demo

基于腾讯云 TRTC-AI TTS (Text-to-Speech) 服务的语音合成演示项目，支持文本转语音、流式合成和声音克隆功能。

## 功能特性

- 🎵 **文本转语音**：支持多种预设音色，24kHz高质量音频输出
- 🌊 **流式合成**：实时流式返回音频数据，减少等待时间
- 🎤 **声音克隆**：上传音频样本，克隆自定义语音
- 🌐 **Web界面**：友好的前端界面，支持音频播放和下载
- 📊 **日志记录**：完整的服务端日志，便于调试和监控

## 快速开始

### 1. 环境要求

- Node.js >= 14.0.0
- npm >= 6.0.0

### 2. 安装依赖

```bash
git clone https://github.com/chicogong/trtc-ai-tts-demo.git
cd trtc-ai-tts-demo
npm install
```

### 3. 配置环境变量

创建 `.env` 文件并配置以下参数：

```bash
TENCENTCLOUD_SECRET_ID=your_secret_id
TENCENTCLOUD_SECRET_KEY=your_secret_key
API_KEY=your_api_key
SDK_APP_ID=your_sdk_app_id
PORT=3000  # 可选，默认3000
```

### 4. 启动服务

```bash
# 生产模式
npm start

# 开发模式（支持热重载）
npm run dev
```

服务启动后，访问 http://localhost:3000 即可使用 Web 界面。

## 项目结构

```
trtc-ai-tts-demo/
├── server.js              # Express 服务器主文件
├── public/
│   └── index.html        # Web 界面
├── logs/                 # 日志文件目录
├── output/               # 克隆语音数据存储
├── test-tts.js           # TTS 功能测试脚本
├── test-clone-correct.js # 声音克隆测试脚本
├── test_data/            # 测试音频文件
├── API.md                # API 接口文档
├── package.json          # 项目配置
└── .env                  # 环境变量配置（需自行创建）
```

## API 接口

### 1. 文本转语音 (TTS)

**接口地址**: `POST /api/tts`

**请求参数**:
```json
{
  "text": "要转换的文本内容",
  "voice": "妮卡"
}
```

**响应格式**:
```json
{
  "success": true,
  "audio": "base64编码的PCM音频数据",
  "sampleRate": 24000,
  "processingTime": 150
}
```

### 2. 流式文本转语音

**接口地址**: `GET /api/tts/stream`

**请求参数**: 
- `text`: 要转换的文本内容（URL编码）
- `voice`: 音色ID（URL编码）

**示例**: `GET /api/tts/stream?text=你好世界&voice=妮卡`

### 3. 声音克隆

**接口地址**: `POST /api/voice-clone`

**请求格式**: multipart/form-data
- `voiceName`: 克隆声音的名称
- `audioFile`: 音频文件（WAV格式，16kHz，单声道，5-12秒）

### 4. 获取克隆音色列表

**接口地址**: `GET /api/cloned-voices`

## 技术架构

### 后端技术栈
- **框架**：Express.js
- **SDK**：tencentcloud-sdk-nodejs-trtc
- **日志**：Winston
- **文件上传**：Multer

### 前端技术栈
- **界面**：原生 HTML5 + CSS3
- **音频处理**：Web Audio API
- **流式传输**：Server-Sent Events (SSE)

## 音频格式说明

### TTS 输出格式
- **格式**：PCM (脉冲编码调制)
- **采样率**：24000 Hz (24kHz)
- **位深度**：16-bit
- **声道**：单声道 (Mono)
- **编码**：Base64

### 声音克隆输入要求
- **格式**：WAV
- **采样率**：16000 Hz (16kHz)
- **声道**：单声道
- **时长**：5-12秒（推荐）
- **内容**：清晰人声，无背景噪音

## 可用音色

### 预设音色

**女声**：xxx
**男声**：xxx

### 克隆音色

通过上传音频样本创建自定义音色，支持任意语音特征的克隆。克隆的语音ID会保存在 `output/cloned_voices.json` 文件中。

## 核心功能实现

### PCM 转 WAV 转换

由于腾讯云 TRTC-AI TTS 返回的是 PCM 格式音频，前端需要转换为 WAV 格式才能播放：

```javascript
function pcmToWav(pcmData, sampleRate = 24000) {
    // 构建 WAV 文件头
    // 设置采样率、位深度、声道数
    // 返回可播放的 WAV Blob
}
```

### 流式合成实现

使用 Server-Sent Events 实现音频流式传输：

```javascript
// 服务端
const eventSource = new EventSource('/api/tts/stream?text=...');

// 客户端接收
eventSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    // 处理音频块
};
```


## 开发指南

### 添加新音色

在 `server.js` 中的音色列表添加新的音色配置：

```javascript
app.get('/api/voices', (_, res) => {
  res.json({
    success: true,
    voices: [
      { id: '新音色ID', name: '新音色名称', gender: 'male/female' },
      // ...
    ]
  });
});
```

### 自定义采样率

前端 PCM 转 WAV 函数支持自定义采样率：

```javascript
// 使用 16kHz 采样率
const blob = pcmToWav(arrayBuffer, 16000);

// 使用 24kHz 采样率（默认）
const blob = pcmToWav(arrayBuffer, 24000);
```

## 注意事项

1. **API 安全**：确保腾讯云密钥安全，不要提交到版本控制
2. **音频质量**：声音克隆需要高质量的音频样本
3. **采样率匹配**：确保前后端采样率设置一致（24kHz）
4. **文件大小**：克隆音频建议不超过 10MB
5. **并发限制**：生产环境建议添加速率限制

## 故障排查

### 常见问题

1. **音频播放声音异常**
   - 检查采样率是否正确（应为 24kHz）
   - 确认 PCM 到 WAV 转换正确

2. **声音克隆失败**
   - 确保音频格式为 16kHz WAV
   - 检查音频时长（5-12秒）
   - 验证音频质量（清晰、无噪音）

3. **API 调用失败**
   - 检查环境变量配置
   - 确认腾讯云服务已开通
   - 查看服务器日志


## 参考资源

- [腾讯云 SDK 文档](https://github.com/TencentCloud/tencentcloud-sdk-nodejs)

## License

MIT

## 贡献指南

欢迎提交 Issue 和 Pull Request！

提交 PR 前请确保：
1. 代码符合项目规范
2. 添加必要的测试
3. 更新相关文档

## 联系方式

如有问题或建议，请提交 [Issue](https://github.com/chicogong/trtc-ai-tts-demo/issues)