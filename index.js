const express = require('express');
const cors = require('cors');
const { OpenAI } = require('openai');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Configuração do cliente NVIDIA com limite de 35 segundos para conexões lentas
const nvidia = new OpenAI({
  apiKey: process.env.NVIDIA_API_KEY,
  baseURL: 'https://integrate.api.nvidia.com/v1',
  timeout: 35000 
});

app.post('/api/perguntar', async (req, res) => {
  const { pergunta } = req.body;

  if (!pergunta) {
    return res.status(400).json({ error: 'Por favor, forneça uma pergunta.' });
  }

  try {
    console.log(`[TecAI] Processando pergunta: "${pergunta}"`);

    // 1. Competidores Oficiais do seu catálogo
    const [chamadaDeepSeek, chamadaGemma] = await Promise.all([
      nvidia.chat.completions.create({
        model: "deepseek-ai/deepseek-v4-flash",
        messages: [{ role: "user", content: pergunta }]
      }).catch(err => ({ error: true, message: err.message })),

      nvidia.chat.completions.create({
        model: "google/diffusiongemma-26b-a4b-it",
        messages: [{ role: "user", content: pergunta }]
      }).catch(err => ({ error: true, message: err.message }))
    ]);

    const respostaDeepSeek = chamadaDeepSeek.error ? `Erro: ${chamadaDeepSeek.message}` : chamadaDeepSeek.choices[0].message.content;
    const respostaGemma = chamadaGemma.error ? `Erro: ${chamadaGemma.message}` : chamadaGemma.choices[0].message.content;

    // Se ambos falharem miseravelmente por rede ou créditos
    if (chamadaDeepSeek.error && chamadaGemma.error) {
      return res.status(502).json({ 
        error: `Ambos os modelos falharam. Detalhes:\n- DeepSeek: ${chamadaDeepSeek.message}\n- Gemma: ${chamadaGemma.message}` 
      });
    }

    // 2. Construindo o Ringue para o Juiz
    const promptJuiz = `
Você é um avaliador rigoroso e especialista em respostas de Inteligência Artificial.
Analise a pergunta original do usuário e escolha qual das duas opções fornecidas é a melhor (mais precisa, clara e completa).
Sua resposta deve conter APENAS E EXATAMENTE o texto da melhor opção escolhida. Não adicione saudações, explicações ou justificativas.

Pergunta do Usuário: "${pergunta}"

Opção 1:
${respostaDeepSeek}

Opção 2:
${respostaGemma}
    `;

    // 3. O Juiz oficial do seu painel (blindado com .catch)
    const chamadaJuiz = await nvidia.chat.completions.create({
      model: "deepseek-ai/deepseek-v4-pro",
      messages: [{ role: "user", content: promptJuiz }]
    }).catch(err => ({ error: true, message: err.message }));

    // Se o Juiz falhar, ele nos avisa o motivo exato na tela
    if (chamadaJuiz.error) {
      return res.status(502).json({ 
        error: `Os competidores responderam, mas o Juiz (DeepSeek-Pro) falhou. Motivo: ${chamadaJuiz.message}`,
        auditoria: { deepseek: respostaDeepSeek, gemma: respostaGemma }
      });
    }

    const respostaVencedora = chamadaJuiz.choices[0].message.content;

    // 4. Tudo certo! Devolve a resposta
    res.json({
      respostaFinal: respostaVencedora,
      auditoria: {
        deepseek: respostaDeepSeek,
        gemma: respostaGemma
      }
    });

  } catch (error) {
    console.error('Erro inesperado no servidor:', error);
    res.status(500).json({ error: `Erro interno no servidor: ${error.message}` });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor ativo na porta ${PORT}`);
});
