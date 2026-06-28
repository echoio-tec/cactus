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
  timeout: 45000 
});

async function buscarNaWeb(query) {
  try {
    console.log(`[WebSearch] Pesquisando na internet por: "${query}"`);
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
    });
    
    if (!response.ok) throw new Error('Bloqueio de rede ou timeout');
    const html = await response.text();
    
    const matches = [...html.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)];
    const trechos = matches.slice(0, 3).map(m => m[1].replace(/<[^>]*>/g, '').trim());
    
    if (trechos.length === 0) return "Aviso: O buscador não retornou resultados válidos (Pode ter ocorrido um bloqueio por CAPTCHA no Render).";
    return trechos.join('\n\n');
  } catch (err) {
    console.error('Erro ao realizar busca web:', err);
    return `Erro na busca: ${err.message}`;
  }
}

app.post('/api/perguntar', async (req, res) => {
  const { historico, customInstructions, memoryContext, pesquisaWeb } = req.body;

  if (!historico || historico.length === 0) {
    return res.status(400).json({ error: 'Por favor, forneça o histórico da conversa.' });
  }

  const ultimaPergunta = historico[historico.length - 1].content;
  let dadosInternet = "Pesquisa na Internet desativada para esta rodada.";

  try {
    const mensagensSistema = [];
    
    if (memoryContext) {
      mensagensSistema.push({ role: "system", content: `Memória sobre o usuário: ${memoryContext}` });
    }
    
    if (customInstructions) {
      mensagensSistema.push({ role: "system", content: `Instruções de estilo: ${customInstructions}` });
    }

    if (pesquisaWeb) {
      dadosInternet = await buscarNaWeb(ultimaPergunta);
      mensagensSistema.push({ 
        role: "system", 
        content: `CONTEXTO DE PESQUISA NA INTERNET (ANO ATUAL: 2026):\nUse as seguintes informações coletadas da web em tempo real para responder:\n${dadosInternet}` 
      });
    }

    const promptFinalModelos = [...mensagensSistema, ...historico];

    const [chamadaDeepSeek, chamadaGemma, chamadaLlama8b] = await Promise.all([
      nvidia.chat.completions.create({ model: "deepseek-ai/deepseek-v4-flash", messages: promptFinalModelos }).catch(err => ({ error: true, message: err.message })),
      nvidia.chat.completions.create({ model: "google/diffusiongemma-26b-a4b-it", messages: promptFinalModelos }).catch(err => ({ error: true, message: err.message })),
      nvidia.chat.completions.create({ model: "meta/llama-3.1-8b-instruct", messages: promptFinalModelos }).catch(err => ({ error: true, message: err.message }))
    ]);

    const respostaDeepSeek = chamadaDeepSeek.error ? `Erro: ${chamadaDeepSeek.message}` : (chamadaDeepSeek.choices?.[0]?.message?.content || "Vazio.");
    const respostaGemma = chamadaGemma.error ? `Erro: ${chamadaGemma.message}` : (chamadaGemma.choices?.[0]?.message?.content || "Vazio.");
    const respostaLlama8b = chamadaLlama8b.error ? `Erro: ${chamadaLlama8b.message}` : (chamadaLlama8b.choices?.[0]?.message?.content || "Vazio.");

    const promptJuiz = `
Você é um avaliador rigoroso de IA. Escolha qual das três opções fornecidas é a melhor e mais precisa.
Retorne APENAS o texto da melhor opção escolhida, sem adendos.

Última Pergunta: "${ultimaPergunta}"

Opção 1: ${respostaDeepSeek}
Opção 2: ${respostaGemma}
Opção 3: ${respostaLlama8b}
    `;

    const llamadaJuiz = await nvidia.chat.completions.create({
      model: "meta/llama-3.1-70b-instruct",
      messages: [{ role: "user", content: promptJuiz }]
    }).catch(err => ({ error: true, message: err.message }));

    const respostaVencedora = llamadaJuiz.error ? respostaDeepSeek : llamadaJuiz.choices?.[0]?.message?.content;

    res.json({
      respostaFinal: respostaVencedora,
      auditoria: { 
        deepseek: respostaDeepSeek, 
        gemma: respostaGemma, 
        llama8b: respostaLlama8b,
        webRaw: dadosInternet // Injetado com sucesso para visualização do front
      }
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor ativo na porta ${PORT}`));
