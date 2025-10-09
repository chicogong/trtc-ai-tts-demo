const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');
const multer = require('multer');
const fs = require('fs');

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
    const { text, voice, voiceId } = req.body;
    const selectedVoice = voiceId || voice;
    
    if (!text) {
      return res.status(400).json({
        success: false,
        error: '文本不能为空'
      });
    }
    
    const startTime = Date.now();
    console.log(`TTS request: "${text.substring(0, 30)}...", voice: ${selectedVoice}`);
    
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
      console.log(`TTS response: ${audioSize} bytes, ${processingTime}ms`);
      
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
    console.error('TTS error:', error);
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
  const voice = req.query.voice || req.query.voiceId;
  
  if (!text) {
    return res.status(400).json({
      success: false,
      error: '文本不能为空'
    });
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
      
      console.log(`Streaming response: ${audioSize} bytes, first chunk: ${firstChunkTime}ms, total: ${totalProcessingTime}ms`);
    }
    
    res.write(`data: ${JSON.stringify({ 
      done: true,
      processingTime: totalProcessingTime
    })}\n\n`);
    
  } catch (error) {
    console.error('Streaming TTS error:', error);
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
    
    console.log(`Voice clone: "${name}", ${(req.file.size / 1024).toFixed(1)}KB`);

    const audioBuffer = req.file.buffer;
    let sampleRate = 16000;
    let channels = 1;
    let bitsPerSample = 16;
    let dataSize = 0;
    let duration = 0;

    if (audioBuffer.length > 44) {
      try {
        // Check if this is a valid WAV file
        const riff = audioBuffer.toString('ascii', 0, 4);
        const wave = audioBuffer.toString('ascii', 8, 12);

        if (riff !== 'RIFF' || wave !== 'WAVE') {
          return res.status(400).json({
            success: false,
            error: '请上传有效的 WAV 格式文件'
          });
        }

        // Read basic WAV header info from fixed positions
        sampleRate = audioBuffer.readUInt32LE(24);
        channels = audioBuffer.readUInt16LE(22);
        bitsPerSample = audioBuffer.readUInt16LE(34);

        // Search for the 'data' chunk (it may not be at position 40)
        let offset = 12; // Start after 'RIFF' and 'WAVE' headers
        let foundDataChunk = false;

        while (offset < audioBuffer.length - 8) {
          const chunkId = audioBuffer.toString('ascii', offset, offset + 4);
          const chunkSize = audioBuffer.readUInt32LE(offset + 4);

          if (chunkId === 'data') {
            dataSize = chunkSize;
            foundDataChunk = true;
            break;
          } else if (chunkId === 'fmt ') {
            // Already read fmt chunk data above
          }

          // Move to next chunk
          offset += 8 + chunkSize;
          // Ensure word alignment (chunks are word-aligned)
          if (chunkSize % 2 !== 0) offset += 1;

          // Safety check to prevent infinite loop
          if (offset >= audioBuffer.length || chunkSize === 0) {
            break;
          }
        }

        // If we couldn't find the data chunk, estimate from file size
        if (!foundDataChunk || dataSize === 0) {
          console.warn('Could not find data chunk in WAV file, estimating from file size');
          // Estimate data size (total size minus typical header size)
          dataSize = audioBuffer.length - offset - 8;
          if (dataSize < 0) dataSize = audioBuffer.length - 44;
        }

        // Calculate duration
        const bytesPerSample = bitsPerSample / 8;
        const bytesPerSecond = sampleRate * channels * bytesPerSample;
        if (bytesPerSecond > 0) {
          duration = dataSize / bytesPerSecond;
        }

        console.log(`Audio format: ${sampleRate}Hz, ${channels}ch, ${bitsPerSample}bit, ${duration.toFixed(1)}s, dataSize: ${dataSize}`);

        if (sampleRate !== 16000) {
          console.warn(`Audio sample rate: ${sampleRate}Hz (16kHz recommended)`);
        }

        // Validate duration
        if (duration < 4) {
          return res.status(400).json({
            success: false,
            error: `音频时长太短：${duration.toFixed(1)}秒，建议4-12秒`
          });
        }

        if (duration > 12) {
          console.warn(`Audio duration: ${duration.toFixed(1)}s (5-12s recommended)`);
        }

      } catch (parseError) {
        console.error('Error parsing WAV header:', parseError);
        return res.status(400).json({
          success: false,
          error: '音频文件格式错误，请上传有效的 WAV 文件'
        });
      }
    } else {
      return res.status(400).json({
        success: false,
        error: '音频文件太小，请上传有效的 WAV 文件'
      });
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
      console.log(`Voice clone success: ${response.VoiceId}`);
      
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
    console.error('Voice clone error:', error);
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

// 5. Get available voices list (从环境变量读取)
app.get('/api/voices', (_, res) => {
  // 从环境变量读取音色列表，支持逗号分隔
  let voices = [];

  if (process.env.VOICE_LIST) {
    voices = process.env.VOICE_LIST.split(',').map(v => v.trim()).filter(v => v);
  }

  res.json({
    success: true,
    voices: voices
  });
});


// Error handling
app.use((err, _, res) => {
  console.error('Server error:', err);
  res.status(500).json({
    error: err.message || '服务器内部错误'
  });
});

// Start server
app.listen(port, () => {
  console.log(`🚀 TTS Server is running on http://localhost:${port}`);
});
