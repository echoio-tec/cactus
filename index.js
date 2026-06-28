const express = require('express');
const cors = require('cors');
const { OpenAI } = require('openai');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Configuração do cliente NVIDIA adaptada para o modelo de 550B (Tolerância de 60 segundos)
const nvidia = new OpenAI({
  apiKey: process.env.NVIDIA_API_KEY,
  baseURL: 'https://integrate.api.nvidia.com/v1',
  timeout: 60000 // Aumentado para 60s para dar tempo ao raciocínio profundo
});

app.post('/api/perguntar', async (req, res) => {
  const { pergunta } = req.body;

  if (!pergunta) {
    return res.status(400).json({ error: 'Por favor, forneça uma pergunta.' });
  }

  try {
    console.log(`[TecAI] Iniciando rodada com o Juiz 550B para: "${pergunta}"`);

    // 1. Disparando os competidores rápidos em paralelo
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

    if (chamadaDeepSeek.error && chamadaGemma.error) {
      return res.status(502).json({ 
        error: `Ambos os competidores falharam. Detalhes:\n- DeepSeek: ${respostaDeepSeek}\n- Gemma: ${respostaGemma}` 
      });
    }

    // 2. Montando o cenário de avaliação crítica
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

    // 3. O Juiz Supremo (Nemotron-3-Ultra-550B) aplicando as variáveis que você descobriu
    const chamadaJuiz = await nvidia.chat.completions.create({
      model: "nvidia/nemotron-3-ultra-550b-a55b",
      messages: [{ role: "user", content: promptJuiz }],
      temperature: 1,
      top_p: 0.95,
      max_tokens: 16384,
      reasoning_budget: 16384,
      chat_template_kwargs: { "enable_thinking": true } // Ativa o modo de pensamento interno
    }).catch(err => ({ error: true, message: err.message }));

    if (chamadaJuiz.error) {
      return res.status(502).json({ 
        error: `Os competidores responderam, mas o Juiz de 550B falhou. Motivo: ${chamadaJuiz.message}`,
        auditoria: { deepseek: respostaDeepSeek, gemma: respostaGemma }
      });
    }

    const respostaVencedora = chamadaJuiz.choices[0].message.content;

    // 4. Retorno de sucesso para a interface gráfica
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
