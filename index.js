const express = require('express');
const app = express();
const { OpenAI } = require('openai');
const cors = require('cors');

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const nvidia = new OpenAI({
  apiKey: process.env.NVIDIA_API_KEY,
  baseURL: 'https://integrate.api.nvidia.com/v1',
});

app.post('/api/perguntar', async (req, res) => {
  const { historico } = req.body;
  const ultima = historico[historico.length - 1].content;

  // Geração de imagem simples via URL
  if (ultima.startsWith('/gerar')) {
    const prompt = ultima.replace('/gerar ', '');
    try {
      const completion = await nvidia.images.generate({
        model: "stabilityai/sdxl-turbo",
        prompt: prompt,
      });
      return res.json({ respostaFinal: `![Imagem](${completion.data[0].url})` });
    } catch (e) {
      return res.json({ respostaFinal: "Erro na geração. Detalhe: " + e.message });
    }
  }

  // Chat padrão
  try {
    const completion = await nvidia.chat.completions.create({
      model: "deepseek-ai/deepseek-v4-flash",
      messages: historico
    });
    res.json({ respostaFinal: completion.choices[0].message.content });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(3000, () => console.log('Cactus ON.'));
