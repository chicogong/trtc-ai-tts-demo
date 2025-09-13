const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
// Simple logging helper
const log = {
  info: (msg, data) => console.log(`[INFO] ${msg}`, data || ''),
  error: (msg, error) => console.error(`[ERROR] ${msg}`, error?.message || error || ''),
  warn: (msg, data) => console.warn(`[WARN] ${msg}`, data || '')
};

// 加载腾讯云SDK
const tencentcloud = require("tencentcloud-sdk-nodejs-trtc");
const TrtcClient = tencentcloud.trtc.v20190722.Client;

dotenv.config();

const app = express();
const port = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static('public'));

// Configure multer for file uploads
const storage = multer.memoryStorage();
const upload = multer({ 
  storage: storage,
  limits: { 
    fileSize: 5 * 1024 * 1024 // 5MB limit
  }
});

// 初始化腾讯云客户端
function createTrtcClient() {
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
  
  return new TrtcClient(clientConfig);
}

// PCM转WAV已移至前端处理

// Routes
app.get('/', (_, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 1. Text to Speech API - 返回PCM数据
app.post('/api/tts', async (req, res) => {
  try {
    const { text, voice = '妮卡', voiceId } = req.body;
    const selectedVoice = voiceId || voice || '妮卡';
    
    if (!text) {
      return res.status(400).json({
        success: false,
        error: '文本不能为空'
      });
    }
    
    const startTime = Date.now();
    log.info(`TTS request: "${text.substring(0, 30)}...", voice: ${selectedVoice}`);
    
    const client = createTrtcClient();
    const params = {
      Text: text,
      Voice: {
        VoiceId: selectedVoice
      },
      SdkAppId: parseInt(process.env.SDK_APP_ID),
      APIKey: process.env.API_KEY
    };
    
    const response = await client.TextToSpeech(params);
    const processingTime = Date.now() - startTime;
    
    if (response.Audio) {
      const audioSize = Buffer.from(response.Audio, 'base64').length;
      log.info(`TTS response: ${audioSize} bytes, ${processingTime}ms`);
      
      res.json({
        success: true,
        audio: response.Audio,
        sampleRate: 24000,
        processingTime: processingTime
      });
    } else {
      throw new Error('No audio data in response');
    }
    
  } catch (error) {
    log.error('TTS error:', error);
    res.status(500).json({
      success: false,
      error: error.message || '服务器错误'
    });
  }
});

// 2. Streaming TTS API - SSE流式传输PCM片段
app.get('/api/tts/stream', async (req, res) => {
  // 获取URL参数，Express已经自动解码
  const text = req.query.text || '';
  const voice = req.query.voice || req.query.voiceId || '妮卡';
  
  if (!text) {
    return res.status(400).json({
      success: false,
      error: '文本不能为空'
    });
  }
  
  const requestStartTime = Date.now();
  log.info(`Streaming TTS: "${text.substring(0, 30)}...", voice: ${voice}`);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'X-Accel-Buffering': 'no'
  });

  res.write(':ok\n\n');

  try {
    const client = createTrtcClient();
    const params = {
      Text: text,
      Voice: {
        VoiceId: voice
      },
      SdkAppId: parseInt(process.env.SDK_APP_ID),
      APIKey: process.env.API_KEY
    };
    
    const response = await client.TextToSpeech(params);
    const totalProcessingTime = Date.now() - requestStartTime;
    
    if (response.Audio) {
      const fullAudio = response.Audio;
      const audioSize = Buffer.from(fullAudio, 'base64').length;
      
      const chunkCount = 5;
      const chunkSize = Math.floor(fullAudio.length / chunkCount);
      let firstChunkSent = false;
      let firstChunkTime = 0;
      
      for (let i = 0; i < chunkCount; i++) {
        const start = i * chunkSize;
        const end = (i === chunkCount - 1) ? fullAudio.length : start + chunkSize;
        const chunk = fullAudio.slice(start, end);
        
        if (chunk) {
          const chunkData = {
            audio: chunk,
            chunkIndex: i,
            totalChunks: chunkCount,
            isLast: (i === chunkCount - 1)
          };
          
          if (!firstChunkSent) {
            firstChunkTime = Date.now() - requestStartTime;
            chunkData.firstChunkTime = firstChunkTime;
            firstChunkSent = true;
          }
          
          res.write(`data: ${JSON.stringify(chunkData)}\n\n`);
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      }
      
      log.info(`Streaming response: ${audioSize} bytes, first chunk: ${firstChunkTime}ms, total: ${totalProcessingTime}ms`);
    }
    
    res.write(`data: ${JSON.stringify({ 
      done: true,
      processingTime: totalProcessingTime
    })}\n\n`);
    
  } catch (error) {
    log.error('Streaming TTS error:', error);
    res.write(`data: ${JSON.stringify({ 
      error: error.message || '流式TTS失败',
      success: false
    })}\n\n`);
  } finally {
    res.end();
  }
});

// 3. Voice Clone API - 接收前端处理好的16kHz WAV
app.post('/api/voice-clone', upload.single('audioFile'), async (req, res) => {
  try {
    const { voiceName: name } = req.body;
    
    if (!name) {
      return res.status(400).json({
        error: '声音名称不能为空'
      });
    }
    
    if (!req.file) {
      return res.status(400).json({
        error: '请上传音频文件'
      });
    }
    
    log.info(`Voice clone: "${name}", ${(req.file.size / 1024).toFixed(1)}KB`);
    
    const audioBuffer = req.file.buffer;
    if (audioBuffer.length > 8) {
      const sampleRate = audioBuffer.readUInt32LE(24);
      const channels = audioBuffer.readUInt16LE(22);
      const dataSize = audioBuffer.readUInt32LE(40);
      const duration = dataSize / (sampleRate * channels * 2);
      
      if (sampleRate !== 16000) {
        log.warn(`Audio sample rate: ${sampleRate}Hz (16kHz recommended)`);
      }
      if (duration < 5 || duration > 12) {
        log.warn(`Audio duration: ${duration.toFixed(1)}s (5-12s recommended)`);
      }
    }
    
    const client = createTrtcClient();
    
    // 构建请求参数 - 参考test-clone-correct.js
    const params = {
      SdkAppId: parseInt(process.env.SDK_APP_ID),
      APIKey: process.env.API_KEY,
      VoiceName: name,
      PromptAudio: audioBuffer.toString('base64')
    };
    
    // 调用声音克隆API
    const response = await client.VoiceClone(params);
    
    if (response.VoiceId) {
      log.info(`Voice clone success: ${response.VoiceId}`);
      
      // 保存克隆信息到文件
      const cloneInfo = {
        voiceId: response.VoiceId,
        voiceName: name,
        createdAt: new Date().toISOString(),
        requestId: response.RequestId
      };
      
      const outputDir = path.join(__dirname, 'output');
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }
      
      const clonedVoices = [];
      try {
        const existing = fs.readFileSync(path.join(outputDir, 'cloned_voices.json'), 'utf8');
        clonedVoices.push(...JSON.parse(existing));
      } catch (e) {
        // File doesn't exist yet
      }
      
      clonedVoices.push(cloneInfo);
      fs.writeFileSync(
        path.join(outputDir, 'cloned_voices.json'), 
        JSON.stringify(clonedVoices, null, 2)
      );
      
      res.json({
        success: true,
        voiceId: response.VoiceId
      });
    } else {
      throw new Error('No VoiceId in response');
    }
    
  } catch (error) {
    log.error('Voice clone error:', error);
    res.status(500).json({
      success: false,
      error: error.message || '声音克隆失败'
    });
  }
});

// 4. Get cloned voices list (从文件读取)
app.get('/api/cloned-voices', (_, res) => {
  try {
    const clonedVoices = JSON.parse(
      fs.readFileSync(path.join(__dirname, 'output', 'cloned_voices.json'), 'utf8')
    );
    res.json({
      success: true,
      voices: clonedVoices
    });
  } catch (e) {
    res.json({
      success: true,
      voices: []
    });
  }
});


// Error handling
app.use((err, req, res, next) => {
  log.error('Server error:', err);
  res.status(500).json({
    error: err.message || '服务器内部错误'
  });
});

// Start server
const server = app.listen(port, () => {
  console.log(`\n🚀 TTS Server is running on http://localhost:${port}`);
  console.log(`\n📌 API Endpoints:`);
  console.log('   POST /api/tts           - 文本转语音');
  console.log('   GET  /api/tts/stream    - 流式TTS');
  console.log('   POST /api/voice-clone   - 声音克隆');
  console.log('   GET  /api/cloned-voices - 克隆音色列表\n');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('\n📛 Shutting down...');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('\n📛 Shutting down...');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});