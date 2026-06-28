const express = require('express');
const cors = require('cors');
const { OpenAI } = require('openai');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const nvidia = new OpenAI({
  apiKey: process.env.NVIDIA_API_KEY,
  baseURL: 'https://integrate.api.nvidia.com/v1',
  timeout: 35000 
});

app.post('/api/perguntar', async (req, res) => {
  // Recebe a pergunta, as regras e a memória vindas do front-end
  const { pergunta, customInstructions, memoryContext } = req.body;

  if (!pergunta) {
    return res.status(400).json({ error: 'Por favor, forneça uma pergunta.' });
  }

  try {
    console.log(`[TecAI] Nova rodada personalizada iniciada para: "${pergunta}"`);

    // Construindo as mensagens do sistema com base na personalização ativada
    const mensagensSistema = [];
    
    if (memoryContext) {
      mensagensSistema.push({ 
        role: "system", 
        content: `Memória/Contexto sobre o usuário (considere isso em suas respostas): ${memoryContext}` 
      });
    }
    
    if (customInstructions) {
      mensagensSistema.push({ 
        role: "system", 
        content: `Instruções estritas de comportamento/estilo do usuário: ${customInstructions}` 
      });
    }

    // Injeta o histórico de contexto antes da pergunta do usuário
    const promptFinalModelos = [...mensagensSistema, { role: "user", content: pergunta }];

    // 1. Executando os 3 competidores em paralelo com as diretrizes personalizadas
    const [chamadaDeepSeek, chamadaGemma, chamadaMiniMax] = await Promise.all([
      nvidia.chat.completions.create({
        model: "deepseek-ai/deepseek-v4-flash",
        messages: promptFinalModelos
      }).catch(err => ({ error: true, message: err.message || 'Erro de conexão' })),

      nvidia.chat.completions.create({
        model: "google/diffusiongemma-26b-a4b-it",
        messages: promptFinalModelos
      }).catch(err => ({ error: true, message: err.message || 'Erro de conexão' })),

      nvidia.chat.completions.create({
        model: "minimaxai/minimax-m3",
        messages: promptFinalModelos
      }).catch(err => ({ error: true, message: err.message || 'Erro de conexão' }))
    ]);

    const respostaDeepSeek = chamadaDeepSeek.error ? `Erro: ${chamadaDeepSeek.message}` : (chamadaDeepSeek.choices?.[0]?.message?.content || "Vazio.");
    const respostaGemma = chamadaGemma.error ? `Erro: ${chamadaGemma.message}` : (chamadaGemma.choices?.[0]?.message?.content || "Vazio.");
    const respostaMiniMax = chamadaMiniMax.error ? `Erro: ${chamadaMiniMax.message}` : (chamadaMiniMax.choices?.[0]?.message?.content || "Vazio.");

    // 2. Montando o Ringue de Avaliação. O Juiz DEVE saber quais eram as regras do usuário!
    const promptJuiz = `
Você é um avaliador rigoroso e especialista em respostas de Inteligência Artificial.
Analise a pergunta original do usuário e escolha qual das três opções fornecidas é a melhor (mais precisa, clara e completa).

CRITÉRIO CRÍTICO DE DESEMPATE:
O usuário definiu estas instruções de personalização: "${customInstructions || 'Nenhuma'}". 
A opção escolhida como vencedora DEVE ser a que melhor seguiu essas regras.

Pergunta do Usuário: "${pergunta}"

Opção 1 (DeepSeek):
${respostaDeepSeek}

Opção 2 (Gemma):
${respostaGemma}

Opção 3 (MiniMax):
${respostaMiniMax}

Sua resposta deve conter APENAS E EXATAMENTE o texto da melhor opção escolhida, sem adendos.
    `;

    // 3. O Juiz decide levando as regras em conta
    const chamadaJuiz = await nvidia.chat.completions.create({
      model: "meta/llama-3.1-70b-instruct",
      messages: [{ role: "user", content: promptJuiz }]
    }).catch(err => ({ error: true, message: err.message || 'Erro no Juiz' }));

    if (chamadaJuiz.error) {
      return res.status(502).json({ 
        error: `O Juiz falhou. Motivo: ${chamadaJuiz.message}`,
        auditoria: { deepseek: respostaDeepSeek, gemma: respostaGemma, minimax: respostaMiniMax }
      });
    }

    const respostaVencedora = chamadaJuiz.choices?.[0]?.message?.content || "Erro ao extrair resposta.";

    res.json({
      respostaFinal: respostaVencedora,
      auditoria: { deepseek: respostaDeepSeek, gemma: respostaGemma, minimax: respostaMiniMax }
    });

  } catch (error) {
    console.error('Erro inesperado:', error);
    res.status(500).json({ error: `Erro interno: ${error.message}` });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor ativo na porta ${PORT}`));
