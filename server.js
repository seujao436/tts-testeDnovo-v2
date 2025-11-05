const express = require('express');
const WebSocket = require('ws');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Configuração do Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ 
  model: "gemini-2.0-flash-exp",
  systemInstruction: "Você é um assistente de voz prestativo e amigável. Responda de forma concisa e natural, como se estivesse conversando. Mantenha as respostas entre 1-3 frases para que sejam adequadas para síntese de voz."
});

// Criar servidor HTTP
const server = require('http').createServer(app);

// Configurar WebSocket
const wss = new WebSocket.Server({ server });

// Armazenar conexões ativas
const clients = new Set();

// Configurações do Eleven Labs
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const VOICE_ID = "21m00Tcm4TlvDq8ikWAM"; // Rachel voice

wss.on('connection', (ws) => {
  console.log('Cliente conectado');
  clients.add(ws);

  // Notificar outros clientes sobre nova conexão
  broadcast({
    type: 'notification',
    message: `Cliente conectado. Total: ${clients.size}`,
    timestamp: new Date().toISOString()
  }, ws);

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      console.log('Mensagem recebida:', data);

      if (data.type === 'chat') {
        // Processar mensagem com Gemini
        const result = await model.generateContent(data.text);
        const response = result.response.text();

        console.log('Resposta do Gemini:', response);

        // Enviar resposta de texto
        ws.send(JSON.stringify({
          type: 'response',
          text: response,
          timestamp: new Date().toISOString()
        }));

        // Gerar áudio com Eleven Labs
        try {
          const audioBuffer = await generateSpeech(response);
          
          // Enviar áudio como base64
          ws.send(JSON.stringify({
            type: 'audio',
            data: audioBuffer.toString('base64'),
            timestamp: new Date().toISOString()
          }));

        } catch (audioError) {
          console.error('Erro ao gerar áudio:', audioError);
          ws.send(JSON.stringify({
            type: 'error',
            message: 'Erro ao gerar áudio',
            timestamp: new Date().toISOString()
          }));
        }

      } else if (data.type === 'audioRequest') {
        // Requisição específica de áudio
        if (data.text) {
          try {
            const audioBuffer = await generateSpeech(data.text);
            ws.send(JSON.stringify({
              type: 'audio',
              data: audioBuffer.toString('base64'),
              timestamp: new Date().toISOString()
            }));
          } catch (error) {
            console.error('Erro ao gerar áudio:', error);
            ws.send(JSON.stringify({
              type: 'error',
              message: 'Erro ao gerar áudio',
              timestamp: new Date().toISOString()
            }));
          }
        }
      }

    } catch (error) {
      console.error('Erro ao processar mensagem:', error);
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Erro interno do servidor',
        timestamp: new Date().toISOString()
      }));
    }
  });

  ws.on('close', () => {
    console.log('Cliente desconectado');
    clients.delete(ws);
    
    // Notificar outros clientes
    broadcast({
      type: 'notification',
      message: `Cliente desconectado. Total: ${clients.size}`,
      timestamp: new Date().toISOString()
    });
  });

  ws.on('error', (error) => {
    console.error('Erro WebSocket:', error);
    clients.delete(ws);
  });
});

// Função para broadcast
function broadcast(data, exclude = null) {
  const message = JSON.stringify(data);
  clients.forEach(client => {
    if (client !== exclude && client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

// Função para gerar speech com Eleven Labs
async function generateSpeech(text) {
  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`, {
    method: 'POST',
    headers: {
      'Accept': 'audio/mpeg',
      'Content-Type': 'application/json',
      'xi-api-key': ELEVENLABS_API_KEY
    },
    body: JSON.stringify({
      text: text,
      model_id: "eleven_monolingual_v1",
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.5
      }
    })
  });

  if (!response.ok) {
    throw new Error(`Eleven Labs API error: ${response.status}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

// Rotas HTTP
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Endpoint para TTS direto (não-streaming)
app.post('/api/tts', async (req, res) => {
  try {
    const { text, voiceId = VOICE_ID } = req.body;
    
    if (!text) {
      return res.status(400).json({ error: 'Texto é obrigatório' });
    }

    const audioBuffer = await generateSpeech(text);
    
    res.set({
      'Content-Type': 'audio/mpeg',
      'Content-Length': audioBuffer.length
    });
    
    res.send(audioBuffer);
    
  } catch (error) {
    console.error('Erro TTS:', error);
    res.status(500).json({ error: 'Erro ao gerar áudio' });
  }
});

// Endpoint para streaming TTS
app.post('/api/tts-stream', async (req, res) => {
  try {
    const { text, voiceId = VOICE_ID } = req.body;
    
    if (!text) {
      return res.status(400).json({ error: 'Texto é obrigatório' });
    }

    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`, {
      method: 'POST',
      headers: {
        'Accept': 'audio/mpeg',
        'Content-Type': 'application/json',
        'xi-api-key': ELEVENLABS_API_KEY
      },
      body: JSON.stringify({
        text: text,
        model_id: "eleven_monolingual_v1",
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.5
        }
      })
    });

    if (!response.ok) {
      throw new Error(`Eleven Labs API error: ${response.status}`);
    }

    res.set({
      'Content-Type': 'audio/mpeg',
      'Transfer-Encoding': 'chunked'
    });

    // Stream da resposta
    response.body.pipe(res);
    
  } catch (error) {
    console.error('Erro TTS Stream:', error);
    res.status(500).json({ error: 'Erro ao gerar áudio' });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    clients: clients.size,
    timestamp: new Date().toISOString()
  });
});

// Iniciar servidor
server.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`📡 WebSocket disponível em ws://localhost:${PORT}`);
  console.log(`🌐 Interface em http://localhost:${PORT}`);
});

// Tratamento de erros
process.on('uncaughtException', (error) => {
  console.error('Erro não capturado:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Promise rejeitada:', reason);
});