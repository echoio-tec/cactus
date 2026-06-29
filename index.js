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
  timeout: 60000
});

function capturarErroMódulo(nomeModelo) {
  return (err) => ({ error: true, message: `Falha no modelo ${nomeModelo}: ${err.message}` });
}

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

async function buscarNaWeb(query) {
  try {
    if (!process.env.TAVILY_API_KEY) return "Aviso: Chave da Tavily ausente.";
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: process.env.TAVILY_API_KEY, query: query, search_depth: "basic", max_results: 3 })
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
    // 🎨 FLUXO DE GERAÇÃO GRÁFICA VIA API NVIDIA
    if (ultimaMensagem.toLowerCase().startsWith('/gerar') || ultimaMensagem.toLowerCase().startsWith('/imagem')) {
      const promptImagem = ultimaMensagem.replace(/^\/(gerar|imagem)\s*/i, '');
      if (!promptImagem) return res.json({ respostaFinal: "Especifique o prompt. Ex: \`/gerar um cacto neon\`" });

      console.log(`[Cactus-Engine] Renderizando arte gráfica para: "${promptImagem}"`);
      try {
        const responseImg = await nvidia.images.generate({
          model: "stabilityai/stable-diffusion-xl",
          prompt: promptImagem
        });
        
        return res.json({
          respostaFinal: `🎨 Aqui está a imagem gerada para **"${promptImagem}"**:\n\n![Imagem Gerada](${responseImg.data[0].url})`,
          auditoria: { deepseek: "Imagem construída via SDXL", gemma: "N/A", llama8b: "N/A", webRaw: "Geração Ativa" }
        });
      } catch (errImg) {
        return res.json({
          respostaFinal: "⚠️ O serviço de geração gráfica do catálogo da NVIDIA está indisponível ou instável. Tente novamente em instantes.",
          auditoria: { deepseek: `Erro: ${errImg.message}`, gemma: "N/A", llama8b: "N/A", webRaw: "Falha técnica" }
        });
      }
    }

    // DIRETRIZ MASTER TEXTUAL
    let sistemaTexto = "Seu nome é Cactus. Você é um assistente de inteligência artificial avançado, forte, resiliente e prestativo. Nunca diga que você é o DeepSeek, Google, Gemma ou Llama. Responda sempre com orgulho que você é o Cactus e que foi projetado de forma personalizada como um agregador inteligente de alto nível.";

    if (memoryContext) sistemaTexto += `\n\n[MEMÓRIA ATIVA SOBRE O USUÁRIO]:\n${memoryContext}`;
    if (customInstructions) sistemaTexto += `\n\n[INSTRUÇÕES ESTREITAS DE ESTILO]:\n${customInstructions}`;
    if (pesquisaWeb) {
      dadosInternet = await buscarNaWeb(ultimaMensagem);
      sistemaTexto += `\n\n[CONTEXTO ATUALIZADO DA INTERNET]:\n${dadosInternet}`;
    }

    const promptTextualPuro = [{ role: "system", content: sistemaTexto }, ...historicoSanitizado];

    let chamadaVision, chamadaDeepSeek, chamadaLlama8b;

    if (arquivoAnexo && arquivoAnexo.tipo === 'imagem') {
      console.log("[Cactus-Engine] Disparando barramento multimodal.");
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

      [chamadaVision, chamadaDeepSeek, chamadaLlama8b] = await Promise.all([
        nvidia.chat.completions.create({ model: "meta/llama-3.2-11b-vision-instruct", messages: promptVisaoPuro }).catch(capturarErroMódulo("Vision-11B")),
        nvidia.chat.completions.create({ model: "deepseek-ai/deepseek-v4-flash", messages: promptTextoCego }).catch(capturarErroMódulo("DeepSeek-Flash")),
        nvidia.chat.completions.create({ model: "meta/llama-3.1-8b-instruct", messages: promptTextoCego }).catch(capturarErroMódulo("Llama-8B"))
      ]);
    } else {
      console.log("[Cactus-Engine] Disparando barramento textual.");
      [chamadaVision, chamadaDeepSeek, chamadaLlama8b] = await Promise.all([
        nvidia.chat.completions.create({ model: "deepseek-ai/deepseek-v4-flash", messages: promptTextualPuro }).catch(capturarErroMódulo("DeepSeek-Flash")),
        nvidia.chat.completions.create({ model: "meta/llama-3.1-8b-instruct", messages: promptTextualPuro }).catch(capturarErroMódulo("Llama-8B")),
        nvidia.chat.completions.create({ model: "meta/llama-3.1-70b-instruct", messages: promptTextualPuro }).catch(capturarErroMódulo("Llama-70B"))
      ]);
    }

    // EXTRAÇÃO SEGURA COMPATÍVEL COM FALHAS PARCIAIS
    const txt1 = chamadaVision.error ? chamadaVision.message : (chamadaVision.choices?.[0]?.message?.content || "Vazio.");
    const txt2 = chamadaDeepSeek.error ? chamadaDeepSeek.message : (chamadaDeepSeek.choices?.[0]?.message?.content || "Vazio.");
    const txt3 = chamadaLlama8b.error ? chamadaLlama8b.message : (chamadaLlama8b.choices?.[0]?.message?.content || "Vazio.");

    const promptJuiz = `
Você é o Juiz do Cactus. Avalie as três opções de resposta e selecione a melhor, mais completa e profunda que responda ao usuário em PORTUGUÊS (PT-BR).
Se houver uma imagem em análise no contexto, dê preferência absoluta para a Opção 1, pois ela foi gerada pelo modelo que possui olhos e realmente viu o arquivo.
Retorne APENAS o texto puro da escolhida, sem introduções.

Pergunta: "${ultimaMensagem}"
Opção 1: ${txt1}
Opção 2: ${txt2}
Opção 3: ${txt3}
    `;

    const chamadaJuiz = await nvidia.chat.completions.create({
      model: "meta/llama-3.1-70b-instruct",
      messages: [{ role: "user", content: promptJuiz }]
    }).catch(() => null);

    const respostaVencedora = (chamadaJuiz && chamadaJuiz.choices?.[0]?.message?.content) ? chamadaJuiz.choices[0].message.content : txt1;

    res.json({
      respostaFinal: respostaVencedora,
      auditoria: { deepseek: txt1, gemma: txt2, llama8b: txt3, webRaw: arquivoAnexo ? `Arquivo: ${arquivoAnexo.nome}` : "Nenhum." }
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[Cactus Engine] Estabilizado na porta ${PORT}`));
