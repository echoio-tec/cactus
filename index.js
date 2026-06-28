const express = require('express');
const cors = require('cors');
const { OpenAI } = require('openai');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Configuração do cliente NVIDIA com limite padrão estável
const nvidia = new OpenAI({
  apiKey: process.env.NVIDIA_API_KEY,
  baseURL: 'https://integrate.api.nvidia.com/v1',
  timeout: 30000 // 30 segundos é mais que suficiente para modelos rápidos
});

app.post('/api/perguntar', async (req, res) => {
  const { pergunta } = req.body;

  if (!pergunta) {
    return res.status(400).json({ error: 'Por favor, forneça uma pergunta.' });
  }

  try {
    console.log(`[TecAI] Nova rodada iniciada para: "${pergunta}"`);

    // 1. Competidores Rápidos (DeepSeek Flash e Gemma)
    const [chamadaDeepSeek, chamadaGemma] = await Promise.all([
      nvidia.chat.completions.create({
        model: "deepseek-ai/deepseek-v4-flash",
        messages: [{ role: "user", content: pregunta }]
      }).catch(err => ({ error: true, message: err.message })),

      nvidia.chat.completions.create({
        model: "google/diffusiongemma-26b-a4b-it",
        messages: [{ role: "user", content: pergunta }]
      }).catch(err => ({ error: true, message: err.message }))
    ]);

    const respostaDeepSeek = chamadaDeepSeek.error ? `Erro no competidor: ${chamadaDeepSeek.message}` : chamadaDeepSeek.choices[0].message.content;
    const respostaGemma = chamadaGemma.error ? `Erro no competidor: ${chamadaGemma.message}` : chamadaGemma.choices[0].message.content;

    // Se ambos falharem por algum motivo de rede
    if (chamadaDeepSeek.error && chamadaGemma.error) {
      return res.status(502).json({ 
        error: `Os competidores falharam ao responder. Tente novamente.` 
      });
    }

    // 2. Montando o Ringue de Avaliação
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

    // 3. O Juiz Inteligente e Ultra-Rápido (Llama 3.1 70B)
    const chamadaJuiz = await nvidia.chat.completions.create({
      model: "meta/llama-3.1-70b-instruct", // Modelo super veloz e maduro
      messages: [{ role: "user", content: promptJuiz }]
    }).catch(err => ({ error: true, message: err.message }));

    if (chamadaJuiz.error) {
      return res.status(502).json({ 
        error: `O Juiz falhou ao dar o veredito. Motivo: ${chamadaJuiz.message}`,
        auditoria: { deepseek: respostaDeepSeek, gemma: respostaGemma }
      });
    }

    const respostaVencedora = chamadaJuiz.choices[0].message.content;

    // 4. Retorno de sucesso instantâneo para a tela
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
