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

// FUNÇÃO ATUALIZADA: Conexão via API oficial da Tavily (Sem bloqueios de IP)
async function buscarNaWeb(query) {
  try {
    if (!process.env.TAVILY_API_KEY) {
      return "Aviso: Chave TAVILY_API_KEY não configurada no Render.";
    }

    console.log(`[Tavily API] Pesquisando dados reais para: "${query}"`);
    
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: process.env.TAVILY_API_KEY,
        query: query,
        search_depth: "basic",
        max_results: 3
      })
    });

    if (!response.ok) throw new Error(`Erro na API Tavily: ${response.status}`);
    const data = await response.json();
    
    if (!data.results || data.results.length === 0) {
      return "Nenhum resultado recente encontrado na internet.";
    }

    // Une os títulos e conteúdos encontrados em um bloco de texto do sistema
    return data.results.map(r => `Título: ${r.title}\nConteúdo: ${r.content}`).join('\n\n');
  } catch (err) {
    console.error('Erro na busca Tavily:', err);
    return `Falha ao obter dados da internet: ${err.message}`;
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
        content: `CONTEXTO DE PESQUISA NA INTERNET (ANO ATUAL: 2026):\nUse as seguintes informações coletadas da web em tempo real para responder com precisão:\n${dadosInternet}` 
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
    const respostaLlama8b = llamadaLlama8b.error ? `Erro: ${llamadaLlama8b.message}` : (llamadaLlama8b.choices?.[0]?.message?.content || "Vazio.");

    const promptJuiz = `
Você é um avaliador rigoroso de IA. Escolha qual das três opções fornece a melhor resposta para o usuário.
Retorne APENAS o texto da melhor opção escolhida, sem comentários extras.

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
        webRaw: dadosInternet 
      }
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor ativo na porta ${PORT}`));
