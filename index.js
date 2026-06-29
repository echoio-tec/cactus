const express = require('express');
const cors = require('cors');
const { OpenAI } = require('openai');

const app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static('public'));

const nvidia = new OpenAI({
  apiKey: process.env.NVIDIA_API_KEY,
  baseURL: 'https://integrate.api.nvidia.com/v1',
  timeout: 45000 
});

// Garante a alternância correta de turnos no histórico
function sanitizarHistorico(historico) {
  const limpo = [];
  for (const msg of historico) {
    if (msg.role === 'system') continue;
    if (limpo.length === 0) {
      if (msg.role === 'user') limpo.push({ role: msg.role, content: msg.content });
    } else {
      const ultima = limpo[limpo.length - 1];
      if (ultima.role === msg.role) {
        ultima.content += `\n${msg.content}`; 
      } else {
        limpo.push({ role: msg.role, content: msg.content });
      }
    }
  }
  return limpo;
}

// BUSCA WEB VIA TAVILY
async function buscarNaWeb(query) {
  try {
    if (!process.env.TAVILY_API_KEY) return "Aviso: Chave da Tavily ausente.";
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
    if (!response.ok) return "Sem resultados.";
    const data = await response.json();
    return data.results ? data.results.map(r => `Título: ${r.title}\nConteúdo: ${r.content}`).join('\n\n') : "Sem dados.";
  } catch (err) {
    return "Falha na busca web.";
  }
}

app.post('/api/perguntar', async (req, res) => {
  const { historico, customInstructions, memoryContext, pesquisaWeb, arquivoAnexo } = req.body;

  if (!historico || historico.length === 0) return res.status(400).json({ error: 'Histórico ausente.' });
  
  const historicoSanitizado = sanitizarHistorico(historico);
  const ultimaMensagem = historicoSanitizado.length > 0 ? historicoSanitizado[historicoSanitizado.length - 1].content : '';
  let dadosInternet = "Pesquisa inativa.";

  try {
    // 🎨 FLUXO ATIVO: GERADOR DE IMAGEM DA NVIDIA (ROTA CORRIGIDA PARA STABLE DIFFUSION)
    if (ultimaMensagem.toLowerCase().startsWith('/gerar') || ultimaMensagem.toLowerCase().startsWith('/imagem')) {
      const promptImagem = ultimaMensagem.replace(/^\/(gerar|imagem)\s*/i, '');
      if (!promptImagem) {
        return res.json({ respostaFinal: "Por favor, especifique o que deseja gerar. Exemplo: `/gerar um cacto no deserto`" });
      }

      console.log(`[Cactus-ImageEngine] Gerando arte gráfica para: "${promptImagem}"`);
      
      // Corrigido o endpoint para o modelo de geração de imagem da NVIDIA
      const responseImg = await nvidia.images.generate({
        model: "блю/stable-diffusion-xl", // Rota estável atualizada do catálogo NIM
        prompt: promptImagem,
        response_format: "url"
      }).catch(err => {
        console.error("Erro no gerador de imagem:", err);
        throw new Error("Falha de comunicação com o serviço de imagem SDXL da NVIDIA.");
      });

      const urlGerada = responseImg.data[0].url;
      return res.json({
        respostaFinal: `🎨 Aqui está a imagem que você pediu para eu gerar sobre **"${promptImagem}"**:\n\n![Imagem Gerada](${urlGerada})`,
        auditoria: { deepseek: "Imagem renderizada via SDXL", gemma: "N/A", llama8b: "N/A", webRaw: "N/A" }
      });
    }

    // DIRETRIZ MASTER TEXTUAL DO CACTUS
    let sistemaTexto = "Seu nome é Cactus. Você é um assistente de inteligência artificial avançado, forte, resiliente e prestativo. Nunca diga que você é o DeepSeek, Google, Gemma ou Llama. Responda sempre com orgulho que você é o Cactus e que foi projetado de forma personalizada como um agregador inteligente de alto nível.";

    if (memoryContext) sistemaTexto += `\n\n[MEMÓRIA ATIVA SOBRE O USUÁRIO]:\n${memoryContext}`;
    if (customInstructions) sistemaTexto += `\n\n[INSTRUÇÕES ESTREITAS DE ESTILO]:\n${customInstructions}`;
    if (pesquisaWeb) {
      dadosInternet = await buscarNaWeb(ultimaMensagem);
      sistemaTexto += `\n\n[CONTEXTO ATUALIZADO DA INTERNET]:\n${dadosInternet}`;
    }

    const promptTextualPuro = [{ role: "system", content: sistemaTexto }, ...historicoSanitizado];

    if (arquivoAnexo && arquivoAnexo.tipo === 'texto') {
      promptTextualPuro.push({ role: "system", content: `[CONTEÚDO DO ARQUIVO DE TEXTO ANEXADO ${arquivoAnexo.nome}]:\n${arquivoAnexo.conteudo}` });
    }

    let chamadaVision, chamadaTextual1, chamadaTextual2;

    if (arquivoAnexo && arquivoAnexo.tipo === 'imagem') {
      console.log("[Cactus-Engine] Executando análise multimodal isolada.");
      
      const promptVisaoPuro = [
        {
          role: "user",
          content: [
            { type: "text", text: `Você é os olhos do Cactus. Analise detidamente o arquivo de imagem anexado e responda à seguinte solicitação em PORTUGUÊS: "${ultimaMensagem}". Faça a leitura completa de todos os textos, dados, gráficos ou tabelas presentes.` },
            { type: "image_url", image_url: { url: arquivoAnexo.conteudo } }
          ]
        }
      ];

      const promptTextoCego = [
        { role: "system", content: sistemaTexto + "\n\n[AVISO]: O usuário enviou uma imagem. Como você é um modelo puramente textual e não tem acesso aos olhos de visão do Cactus, informe que está aguardando o processamento do filtro visual principal." },
        ...historicoSanitizado
      ];

      [chamadaVision, chamadaTextual1, chamadaTextual2] = await Promise.all([
        nvidia.chat.completions.create({ model: "meta/llama-3.2-11b-vision-instruct", messages: promptVisaoPuro }).catch(err => ({ error: true, message: "Erro ao processar imagem no módulo de visão." })),
        nvidia.chat.completions.create({ model: "deepseek-ai/deepseek-v4-flash", messages: promptTextoCego }).catch(err => ({ error: true, message: err.message })),
        nvidia.chat.completions.create({ model: "meta/llama-3.1-8b-instruct", messages: promptTextoCego }).catch(err => ({ error: true, message: err.message }))
      ]);

    } else {
      console.log("[Cactus-Engine] Executando análise textual padrão.");
      [chamadaVision, chamadaTextual1, chamadaTextual2] = await Promise.all([
        nvidia.chat.completions.create({ model: "deepseek-ai/deepseek-v4-flash", messages: promptTextualPuro }).catch(err => ({ error: true, message: err.message })),
        nvidia.chat.completions.create({ model: "meta/llama-3.1-8b-instruct", messages: promptTextualPuro }).catch(err => ({ error: true, message: err.message })),
        nvidia.chat.completions.create({ model: "meta/llama-3.1-70b-instruct", messages: promptTextualPuro }).catch(err => ({ error: true, message: err.message }))
      ]);
    }

    const res1 = chamadaVision.error ? chamadaVision.message : (chamadaVision.choices?.[0]?.message?.content || "Sem resposta.");
    const res2 = chamadaTextual1.error ? chamadaTextual1.message : (chamadaTextual1.choices?.[0]?.message?.content || "Sem resposta.");
    const res3 = chamadaTextual2.error ? chamadaTextual2.message : (chamadaTextual2.choices?.[0]?.message?.content || "Sem resposta.");

    const promptJuiz = `
Você é o Juiz do Cactus. Avalie as três opções de resposta e selecione a melhor, mais completa e profunda que responda ao usuário em PORTUGUÊS (PT-BR).
Se houver uma imagem em análise no contexto, dê preferência absoluta para a Opção 1, pois ela foi gerada pelo modelo que possui olhos e realmente viu o arquivo. As outras opções são cegas por design.
Retorne APENAS o texto puro da escolhida, sem metalinguagem ou introduções.

Pergunta: "${ultimaMensagem}"

Opção 1: ${res1}
Opção 2: ${res2}
Opção 3: ${res3}
    `;

    const chamadaJuiz = await nvidia.chat.completions.create({
      model: "meta/llama-3.1-70b-instruct",
      messages: [{ role: "user", content: promptJuiz }]
    }).catch(() => null);

    const respostaVencedora = (chamadaJuiz && chamadaJuiz.choices?.[0]?.message?.content) ? chamadaJuiz.choices[0].message.content : res1;

    res.json({
      respostaFinal: respostaVencedora,
      auditoria: { deepseek: res1, gemma: res2, llama8b: res3, webRaw: arquivoAnexo ? `Arquivo: ${arquivoAnexo.nome}` : "Nenhum." }
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[Cactus] Operacional com gerador SDXL ativo na porta ${PORT}`));
