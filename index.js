const express = require('express');
const cors = require('cors');
const { OpenAI } = require('openai');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Configuração do cliente NVIDIA com limite estável
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
    console.log(`[TecAI] Nova rodada tripla iniciada para: "${pergunta}"`);

    // 1. Três competidores rodando em paralelo
    const [chamadaDeepSeek, chamadaGemma, chamadaMiniMax] = await Promise.all([
      nvidia.chat.completions.create({
        model: "deepseek-ai/deepseek-v4-flash",
        messages: [{ role: "user", content: pergunta }]
      }).catch(err => ({ error: true, message: err.message || 'Erro de conexão' })),

      nvidia.chat.completions.create({
        model: "google/diffusiongemma-26b-a4b-it",
        messages: [{ role: "user", content: pergunta }]
      }).catch(err => ({ error: true, message: err.message || 'Erro de conexão' })),

      nvidia.chat.completions.create({
        model: "minimaxai/minimax-m3",
        messages: [{ role: "user", content: pergunta }]
      }).catch(err => ({ error: true, message: err.message || 'Erro de conexão' }))
    ]);

    // Uso do ?. (Optional Chaining) para impedir que o servidor quebre se a resposta vier estranha
    const respostaDeepSeek = chamadaDeepSeek.error 
      ? `Erro no competidor: ${chamadaDeepSeek.message}` 
      : (chamadaDeepSeek.choices?.[0]?.message?.content || "Modelo retornou uma estrutura vazia.");

    const respostaGemma = chamadaGemma.error 
      ? `Erro no competidor: ${chamadaGemma.message}` 
      : (chamadaGemma.choices?.[0]?.message?.content || "Modelo retornou uma estrutura vazia.");

    const respostaMiniMax = chamadaMiniMax.error 
      ? `Erro no competidor: ${chamadaMiniMax.message}` 
      : (chamadaMiniMax.choices?.[0]?.message?.content || "Modelo retornou uma estrutura vazia.");

    // 2. Montando o Ringue de Avaliação com as respostas obtidas
    const promptJuiz = `
Você é um avaliador rigoroso e especialista em respostas de Inteligência Artificial.
Analise a pergunta original do usuário e escolha qual das três opções fornecidas é a melhor (mais precisa, clara e completa).
Sua resposta deve conter APENAS E EXATAMENTE o texto da melhor opção escolhida. Não adicione saudações, explicações ou justificativas.

Pergunta do Usuário: "${pergunta}"

Opção 1:
${respostaDeepSeek}

Opção 2:
${respostaGemma}

Opção 3:
${respostaMiniMax}
    `;

    // 3. O Juiz Supremo dá o veredito rápido
    const chamadaJuiz = await nvidia.chat.completions.create({
      model: "meta/llama-3.1-70b-instruct",
      messages: [{ role: "user", content: promptJuiz }]
    }).catch(err => ({ error: true, message: err.message || 'Erro de conexão do Juiz' }));

    if (chamadaJuiz.error) {
      return res.status(502).json({ 
        error: `O Juiz falhou ao dar o veredito. Motivo: ${chamadaJuiz.message}`,
        auditoria: { deepseek: respostaDeepSeek, gemma: respostaGemma, minimax: respostaMiniMax }
      });
    }

    const respostaVencedora = chamadaJuiz.choices?.[0]?.message?.content || "O Juiz não conseguiu extrair um texto válido.";

    // 4. Retorno estruturado com a auditoria tripla segura
    res.json({
      respostaFinal: respostaVencedora,
      auditoria: {
        deepseek: respostaDeepSeek,
        gemma: respostaGemma,
        minimax: respostaMiniMax
      }
    });

  } catch (error) {
    console.error('Erro inesperado no servidor:', error);
    res.status(500).json({ error: `Erro interno no servidor: ${error.message}` });
  }
});

const PORT = process.env.PORT || 3000;
app.use((req, res) => res.status(404).send("Rota não encontrada"));
app.listen(PORT, () => {
  console.log(`Servidor ativo na porta ${PORT}`);
});
