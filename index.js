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

// BUSCA WEB VIA TAVILY
async function buscarNaWeb(query) {
  try {
    if (!process.env.TAVILY_API_KEY) return "Aviso: Chave da Tavily ausente.";
    console.log(`[Cactus-Web] Busca por: "${query}"`);
    
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

    if (!response.ok) throw new Error(`Erro: ${response.status}`);
    const data = await response.json();
    return data.results ? data.results.map(r => `Título: ${r.title}\nConteúdo: ${r.content}`).join('\n\n') : "Sem dados.";
  } catch (err) {
    return `Falha na busca: ${err.message}`;
  }
}

app.post('/api/perguntar', async (req, res) => {
  const { historico, customInstructions, memoryContext, pesquisaWeb } = req.body;

  if (!historico || historico.length === 0) return res.status(400).json({ error: 'Histórico ausente.' });
  const ultimaPergunta = historico[historico.length - 1].content;
  let dadosInternet = "Pesquisa inativa.";

  try {
    // 🚨 REGRA DE OURO: Injeta a identidade Cactus como o primeiro pensamento de todas as IAs
    const mensagensSistema = [
      {
        role: "system",
        content: "Seu nome é Cactus. Você é um assistente de inteligência artificial avançado, forte, resiliente e prestativo. Nunca diga que você é o DeepSeek, Mistral, Google, Gemma ou Llama. Se o usuário perguntar seu nome, quem criou você ou onde você está rodando, responda sempre com orgulho que você é o Cactus e que foi projetado de forma personalizada como um agregador inteligente de alto nível."
      }
    ];

    if (memoryContext) {
      mensagensSistema.push({ role: "system", content: `Memória ativa sobre o usuário: ${memoryContext}` });
    }
    if (customInstructions) {
      mensagensSistema.push({ role: "system", content: `Instruções de estilo do usuário: ${customInstructions}` });
    }

    if (pesquisaWeb) {
      dadosInternet = await buscarNaWeb(ultimaPergunta);
      mensagensSistema.push({ 
        role: "system", 
        content: `CONTEXTO DE PESQUISA NA INTERNET (ANO 2026):\n${dadosInternet}` 
      });
    }

    const promptFinalModelos = [...mensagensSistema, ...historico];

    // Chamada paralela dos competidores
    const [chamadaDeepSeek, llamadaMixtral, chamadaLlama8b] = await Promise.all([
      nvidia.chat.completions.create({ model: "deepseek-ai/deepseek-v4-flash", messages: promptFinalModelos }).catch(err => ({ error: true, message: err.message })),
      nvidia.chat.completions.create({ model: "mistralai/mixtral-8x7b-instruct-v0.1", messages: promptFinalModelos }).catch(err => ({ error: true, message: err.message })),
      nvidia.chat.completions.create({ model: "meta/llama-3.1-8b-instruct", messages: promptFinalModelos }).catch(err => ({ error: true, message: err.message }))
    ]);

    const respostaDeepSeek = chamadaDeepSeek.error ? `Erro: ${chamadaDeepSeek.message}` : (chamadaDeepSeek.choices?.[0]?.message?.content || "Vazio.");
    const respostaMixtral = llamadaMixtral.error ? `Erro: ${llamadaMixtral.message}` : (llamadaMixtral.choices?.[0]?.message?.content || "Vazio.");
    const respostaLlama8b = chamadaLlama8b.error ? `Erro: ${chamadaLlama8b.message}` : (chamadaLlama8b.choices?.[0]?.message?.content || "Vazio.");

    // Promp do Juiz atualizado com a marca Cactus
    const promptJuiz = `
Você é o avaliador e Juiz Supremo do Cactus. 
Sua missão é escolher a melhor resposta entre as três opções fornecidas. 
Escolha a opção que respondeu com mais precisão, clareza e que assumiu perfeitamente a identidade do Cactus, sem revelar marcas externas.

Retorne APENAS E EXATAMENTE o texto da resposta escolhida, sem justificativas ou comentários.

Última Pergunta: "${ultimaPergunta}"

Opção 1: ${respostaDeepSeek}
Opção 2: ${respostaMixtral}
Opção 3: ${respostaLlama8b}
    `;

    const chamadaJuiz = await nvidia.chat.completions.create({
      model: "meta/llama-3.1-70b-instruct",
      messages: [{ role: "user", content: promptJuiz }]
    }).catch(err => ({ error: true, message: err.message }));

    const respostaVencedora = chamadaJuiz.error ? respostaDeepSeek : (chamadaJuiz.choices?.[0]?.message?.content || respostaDeepSeek);

    res.json({
      respostaFinal: respostaVencedora,
      auditoria: { deepseek: respostaDeepSeek, gemma: respostaMixtral, llama8b: respostaLlama8b, webRaw: dadosInternet }
    });

  } catch (error) {
    console.error('Erro inesperado:', error);
    res.status(500).json({ error: `Erro interno: ${error.message}` });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[Cactus] Servidor ativo na porta ${PORT}`));
