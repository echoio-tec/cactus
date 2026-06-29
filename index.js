const express = require('express');
const app = express();
const { OpenAI } = require('openai');
const cors = require('cors');

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

const nvidia = new OpenAI({
  apiKey: process.env.NVIDIA_API_KEY,
  baseURL: 'https://integrate.api.nvidia.com/v1',
});

app.post('/api/perguntar', async (req, res) => {
  const { historico, arquivoAnexo } = req.body;
  const ultimaMensagem = historico[historico.length - 1].content;

  // ROTA DE IMAGEM
  if (ultimaMensagem.toLowerCase().startsWith('/gerar') || ultimaMensagem.toLowerCase().startsWith('/imagem')) {
    const prompt = ultimaMensagem.replace(/^\/(gerar|imagem)\s*/i, '');
    try {
      // Usando a estrutura direta da API da NVIDIA NIM
      const response = await fetch('https://integrate.api.nvidia.com/v1/models/stabilityai/sdxl-turbo/infer', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${process.env.NVIDIA_API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ prompt: prompt, cfg_scale: 5, seed: 42 })
      });
      const data = await response.json();
      return res.json({ respostaFinal: `![Imagem](${data.url})` });
    } catch (e) {
      return res.json({ respostaFinal: "Erro ao gerar imagem. Tente novamente." });
    }
  }

  // ROTA DE CHAT E VISÃO
  try {
    const messages = [...historico];
    if (arquivoAnexo && arquivoAnexo.tipo === 'imagem') {
      messages.push({
        role: "user",
        content: [{ type: "text", text: ultimaMensagem }, { type: "image_url", image_url: { url: arquivoAnexo.conteudo } }]
      });
    }
    
    const completion = await nvidia.chat.completions.create({
      model: arquivoAnexo ? "meta/llama-3.2-11b-vision-instruct" : "deepseek-ai/deepseek-v4-flash",
      messages: messages
    });

    res.json({ respostaFinal: completion.choices[0].message.content });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(3000, () => console.log('Cactus operacional na porta 3000'));
