const express = require('express');
const cors = require('cors');
const { OpenAI } = require('openai');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Configuração do cliente NVIDIA com um teto de 30 segundos para evitar travamentos
const nvidia = new OpenAI({
  apiKey: process.env.NVIDIA_API_KEY,
  baseURL: 'https://integrate.api.nvidia.com/v1',
  timeout: 30000 // 30 segundos de limite máximo
});

app.post('/api/perguntar', async (req, res) => {
  const { pergunta } = req.body;

  if (!pergunta) {
    return res.status(400).json({ error: 'Por favor, forneça uma pergunta.' });
  }

  try {
    console.log(`Disparando busca para os modelos estáveis: "${pergunta}"`);

    // 1. Competidores estáveis e rápidos (Llama da Meta)
    const [chamadaLlama8b, chamadaLlama70b] = await Promise.all([
      nvidia.chat.completions.create({
        model: "meta/llama-3.1-8b-instruct", // Ultra rápido
        messages: [{ role: "user", content: pergunta }]
      }).catch(err => ({ error: true, message: err.message })),

      nvidia.chat.completions.create({
        model: "meta/llama-3.1-70b-instruct", // Muito inteligente e estável
        messages: [{ role: "user", content: pergunta }]
      }).catch(err => ({ error: true, message: err.message }))
    ]);

    const respostaLlama8b = chamadaLlama8b.error ? "Erro no modelo Llama-8B" : chamadaLlama8b.choices[0].message.content;
    const respostaLlama70b = chamadaLlama70b.error ? "Erro no modelo Llama-70B" : chamadaLlama70b.choices[0].message.content;

    // Se ambos falharem por timeout ou rede
    if (chamadaLlama8b.error && chamadaLlama70b.error) {
      return res.status(504).json({ error: 'Os modelos da NVIDIA demoraram demais para responder. Tente novamente em instantes.' });
    }

    // 2. O Prompt do Juiz
    const promptJuiz = `
Você é um avaliador rigoroso de Inteligência Artificial.
Analise a pergunta do usuário e escolha qual das duas opções é a melhor.
Retorne APENAS o texto exato da resposta escolhida. Sem comentários.

Pergunta: "${pergunta}"

Opção 1:
${respostaLlama8b}

Opção 2:
${respostaLlama70b}
    `;

    // 3. O Juiz definitivo da própria NVIDIA (Nemotron)
    const chamadaJuiz = await nvidia.chat.completions.create({
      model: "nvidia/llama-3.1-nemotron-70b-instruct", // Modelo oficial da NVIDIA, super estável
      messages: [{ role: "user", content: promptJuiz }]
    });

    const respostaVencedora = chamadaJuiz.choices[0].message.content;

    res.json({
      respostaFinal: respostaVencedora,
      auditoria: {
        deepseek: respostaLlama8b, // Mantive as chaves do objeto para não precisar mexer no HTML
        gemma: respostaLlama70b
      }
    });

  } catch (error) {
    console.error('Erro geral no processamento:', error);
    res.status(500).json({ error: 'A API da NVIDIA recusou ou demorou a responder. Verifique seus créditos ou tente novamente.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor ativo na porta ${PORT}`);
});
