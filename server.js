const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');
const multer = require('multer');

// 加载腾讯云SDK
const tencentcloud = require("tencentcloud-sdk-nodejs-trtc");
const TrtcClient = tencentcloud.trtc.v20190722.Client;

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static('public'));

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB limit
});

// 腾讯云客户端配置
const clientConfig = {
  credential: {
    secretId: process.env.TENCENTCLOUD_SECRET_ID,
    secretKey: process.env.TENCENTCLOUD_SECRET_KEY,
  },
  region: process.env.TTS_REGION || "ap-beijing",
  profile: {
    httpProfile: {
      endpoint: process.env.TTS_ENDPOINT || "trtc.ai.tencentcloudapi.com",
      reqTimeout: 120,
    },
  },
};

// Routes
app.get('/', (_, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 1. Text to Speech API - 返回PCM数据
app.post('/api/tts', async (req, res) => {
  try {
    const { text, voice, voiceId } = req.body;
    if (!text) {
      return res.status(400).json({ success: false, error: '文本不能为空' });
    }

    const startTime = Date.now();
    console.log(`TTS request: "${text.substring(0, 30)}...", voice: ${voiceId || voice}`);

    const client = new TrtcClient(clientConfig);
    const response = await client.TextToSpeech({
      Text: text,
      Voice: { VoiceId: voiceId || voice },
      SdkAppId: parseInt(process.env.SDK_APP_ID),
      APIKey: process.env.API_KEY
    });

    if (!response.Audio) {
      throw new Error('No audio data in response');
    }

    const processingTime = Date.now() - startTime;
    const audioSize = Buffer.from(response.Audio, 'base64').length;
    console.log(`TTS response: ${audioSize} bytes, ${processingTime}ms`);

    res.json({
      success: true,
      audio: response.Audio,
      sampleRate: 24000,
      processingTime
    });
  } catch (error) {
    console.error('TTS error:', error);
    res.status(500).json({ success: false, error: error.message || '服务器错误' });
  }
});

// 2. Streaming TTS API - SSE流式传输PCM片段
app.get('/api/tts/stream', async (req, res) => {
  const text = req.query.text || '';
  const voice = req.query.voice || req.query.voiceId;

  if (!text) {
    return res.status(400).json({ success: false, error: '文本不能为空' });
  }

  const requestStartTime = Date.now();
  console.log(`Streaming TTS: "${text.substring(0, 30)}...", voice: ${voice}`);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'X-Accel-Buffering': 'no'
  });

  res.write(':ok\n\n');

  try {
    const client = new TrtcClient(clientConfig);
    const response = await client.TextToSpeech({
      Text: text,
      Voice: { VoiceId: voice },
      SdkAppId: parseInt(process.env.SDK_APP_ID),
      APIKey: process.env.API_KEY
    });

    const totalProcessingTime = Date.now() - requestStartTime;

    if (response.Audio) {
      const fullAudio = response.Audio;
      const audioSize = Buffer.from(fullAudio, 'base64').length;
      const chunkCount = 5;
      const chunkSize = Math.floor(fullAudio.length / chunkCount);
      let firstChunkTime = 0;

      for (let i = 0; i < chunkCount; i++) {
        const start = i * chunkSize;
        const end = (i === chunkCount - 1) ? fullAudio.length : start + chunkSize;
        const chunkData = {
          audio: fullAudio.slice(start, end),
          chunkIndex: i,
          totalChunks: chunkCount,
          isLast: (i === chunkCount - 1)
        };

        if (i === 0) {
          firstChunkTime = Date.now() - requestStartTime;
          chunkData.firstChunkTime = firstChunkTime;
        }

        res.write(`data: ${JSON.stringify(chunkData)}\n\n`);
        await new Promise(resolve => setTimeout(resolve, 50));
      }

      console.log(`Streaming response: ${audioSize} bytes, first chunk: ${firstChunkTime}ms, total: ${totalProcessingTime}ms`);
    }

    res.write(`data: ${JSON.stringify({ done: true, processingTime: totalProcessingTime })}\n\n`);
  } catch (error) {
    console.error('Streaming TTS error:', error);
    res.write(`data: ${JSON.stringify({ error: error.message || '流式TTS失败', success: false })}\n\n`);
  } finally {
    res.end();
  }
});

// 3. Voice Clone API
app.post('/api/voice-clone', upload.single('audioFile'), async (req, res) => {
  try {
    const { voiceName } = req.body;

    if (!voiceName) {
      return res.status(400).json({ success: false, error: '声音名称不能为空' });
    }

    if (!req.file) {
      return res.status(400).json({ success: false, error: '请上传音频文件' });
    }

    console.log(`Voice clone: "${voiceName}", ${(req.file.size / 1024).toFixed(1)}KB`);

    const client = new TrtcClient(clientConfig);
    const response = await client.VoiceClone({
      SdkAppId: parseInt(process.env.SDK_APP_ID),
      APIKey: process.env.API_KEY,
      VoiceName: voiceName,
      PromptAudio: req.file.buffer.toString('base64')
    });

    if (!response.VoiceId) {
      throw new Error('No VoiceId in response');
    }

    console.log(`Voice clone success: ${response.VoiceId}`);

    res.json({
      success: true,
      voiceId: response.VoiceId,
      voiceName
    });
  } catch (error) {
    console.error('Voice clone error:', error);
    res.status(500).json({ success: false, error: error.message || '声音克隆失败' });
  }
});

// 4. Get available voices list
app.get('/api/voices', (_, res) => {
  const voices = process.env.VOICE_LIST
    ? process.env.VOICE_LIST.split(',').map(v => v.trim()).filter(v => v)
    : [];

  res.json({ success: true, voices });
});

// Error handling
app.use((err, _, res) => {
  console.error('Server error:', err);
  res.status(500).json({ error: err.message || '服务器内部错误' });
});

// Start server
app.listen(port, () => {
  console.log(`🚀 TTS Server is running on http://localhost:${port}`);
});
