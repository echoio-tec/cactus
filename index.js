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
  timeout: 45000 // Aumentado para 45s para dar tempo da busca web + respostas
});

// FUNÇÃO DE OURO: Busca na internet em tempo real sem precisar de chaves pagas
async function buscarNaWeb(query) {
  try {
    console.log(`[WebSearch] Pesquisando na internet por: "${query}"`);
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    
    if (!response.ok) throw new Error('Falha na resposta da rede');
    const html = await response.text();
    
    // Captura os snippets de resultados reais da página do DuckDuckGo
    const matches = [...html.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)];
    const trechos = matches.slice(0, 3).map(m => m[1].replace(/<[^>]*>/g, '').trim());
    
    if (trechos.length === 0) return "Nenhum resultado recente encontrado na busca rápida.";
    return trechos.join('\n\n');
  } catch (err) {
    console.error('Erro ao realizar busca web:', err);
    return 'Não foi possível obter dados da internet para esta consulta.';
  }
}

app.post('/api/perguntar', async (req, res) => {
  // Recebemos a chave 'pesquisaWeb' vinda do botão da interface
  const { historico, customInstructions, memoryContext, pesquisaWeb } = req.body;

  if (!historico || historico.length === 0) {
    return res.status(400).json({ error: 'Por favor, forneça o histórico da conversa.' });
  }

  const ultimaPergunta = historico[historico.length - 1].content;

  try {
    const mensagensSistema = [];
    
    if (memoryContext) {
      mensagensSistema.push({ role: "system", content: `Memória sobre o usuário: ${memoryContext}` });
    }
    
    if (customInstructions) {
      mensagensSistema.push({ role: "system", content: `Instruções de estilo: ${customInstructions}` });
    }

    // SE A PESQUISA WEB ESTIVER ATIVA: Intercepta o fluxo e busca os fatos de 2026
    if (pesquisaWeb) {
      const dadosInternet = await buscarNaWeb(ultimaPergunta);
      mensagensSistema.push({ 
        role: "system", 
        content: `CONTEXTO DE PESQUISA NA INTERNET (ANO ATUAL: 2026):\nUse as seguintes informações coletadas da web em tempo real para responder com total precisão a fatos recentes:\n${dadosInternet}` 
      });
    }

    const promptFinalModelos = [...mensagensSistema, ...historico];

    // 1. Executando os competidores com o contexto enriquecido da internet
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
        model: "meta/llama-3.1-8b-instruct",
        messages: promptFinalModelos
      }).catch(err => ({ error: true, message: err.message || 'Erro de conexão' }))
    ]);

    const respostaDeepSeek = chamadaDeepSeek.error ? `Erro: ${chamadaDeepSeek.message}` : (chamadaDeepSeek.choices?.[0]?.message?.content || "Vazio.");
    const respostaGemma = chamadaGemma.error ? `Erro: ${chamadaGemma.message}` : (chamadaGemma.choices?.[0]?.message?.content || "Vazio.");
    const respostaLlama8b = chamadaLlama8b.error ? `Erro: ${chamadaLlama8b.message}` : (chamadaLlama8b.choices?.[0]?.message?.content || "Vazio.");

    // 2. O Juiz decide a melhor resposta considerando o cumprimento das informações atualizadas
    const promptJuiz = `
Você é um avaliador rigoroso e especialista em respostas de Inteligência Artificial.
Analise a última pergunta do usuário dentro do contexto recente da conversa e escolha qual das três opções fornecidas é a melhor (mais precisa, clara e completa).

Sua resposta deve conter APENAS E EXATAMENTE o texto da melhor opção escolhida, sem adendos.

Última Pergunta do Usuário: "${ultimaPergunta}"

Opção 1 (DeepSeek):
${respostaDeepSeek}

Opção 2 (Gemma):
${respostaGemma}

Opção 3 (Llama 8B):
${respostaLlama8b}
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
