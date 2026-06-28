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
  const { pergunta, customInstructions, memoryContext } = req.body;

  if (!pergunta) {
    return res.status(400).json({ error: 'Por favor, forneça uma pergunta.' });
  }

  try {
    console.log(`[TecAI] Nova rodada estável iniciada para: "${pergunta}"`);

    const mensagensSistema = [];
    
    if (memoryContext) {
      mensagensSistema.push({ 
        role: "system", 
        content: `Memória/Contexto sobre o usuário: ${memoryContext}` 
      });
    }
    
    if (customInstructions) {
      mensagensSistema.push({ 
        role: "system", 
        content: `Instruções estritas de comportamento/estilo: ${customInstructions}` 
      });
    }

    const promptFinalModelos = [...mensagensSistema, { role: "user", content: pergunta }];

    // 1. Três competidores rápidos e estáveis rodando em paralelo
    const [chamadaDeepSeek, chamadaGemma, chamadaLlama8b] = await Promise.all([
      nvidia.chat.completions.create({
        model: "deepseek-ai/deepseek-v4-flash",
        messages: promptFinalModelos
      }).catch(err => ({ error: true, message: err.message || 'Erro de conexão' })),

      nvidia.chat.completions.create({
        model: "google/diffusiongemma-26b-a4b-it",
        messages: promptFinalModelos
      }).catch(err => ({ error: true, message: err.message || 'Erro de conexão' })),

      nvidia.chat.completions.create({
        model: "meta/llama-3.1-8b-instruct", // Nova IA adicionada aqui!
        messages: promptFinalModelos
      }).catch(err => ({ error: true, message: err.message || 'Erro de conexão' }))
    ]);

    const respostaDeepSeek = chamadaDeepSeek.error ? `Erro: ${chamadaDeepSeek.message}` : (chamadaDeepSeek.choices?.[0]?.message?.content || "Vazio.");
    const respostaGemma = chamadaGemma.error ? `Erro: ${chamadaGemma.message}` : (chamadaGemma.choices?.[0]?.message?.content || "Vazio.");
    const respostaLlama8b = chamadaLlama8b.error ? `Erro: ${chamadaLlama8b.message}` : (chamadaLlama8b.choices?.[0]?.message?.content || "Vazio.");

    // 2. Montando o Ringue de Avaliação para o Juiz 70B
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

Opção 3 (Llama 8B):
${respostaLlama8b}

Sua resposta deve conter APENAS E EXATAMENTE o texto da melhor opção escolhida, sem adendos.
    `;

    const llamadaJuiz = await nvidia.chat.completions.create({
      model: "meta/llama-3.1-70b-instruct",
      messages: [{ role: "user", content: promptJuiz }]
    }).catch(err => ({ error: true, message: err.message || 'Erro no Juiz' }));

    if (llamadaJuiz.error) {
      return res.status(502).json({ 
        error: `O Juiz falhou. Motivo: ${llamadaJuiz.message}`,
        auditoria: { deepseek: respostaDeepSeek, gemma: respostaGemma, llama8b: respostaLlama8b }
      });
    }

    const respostaVencedora = llamadaJuiz.choices?.[0]?.message?.content || "Erro ao extrair resposta.";

    res.json({
      respostaFinal: respostaVencedora,
      auditoria: { deepseek: respostaDeepSeek, gemma: respostaGemma, llama8b: respostaLlama8b }
    });

  } catch (error) {
    console.error('Erro inesperado:', error);
    res.status(500).json({ error: `Erro interno: ${error.message}` });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor ativo na porta ${PORT}`));
