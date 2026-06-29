const express = require('express');
const cors = require('cors');
const { OpenAI } = require('openai');

const app = report = express();

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static('public'));

const nvidia = new OpenAI({
  apiKey: process.env.NVIDIA_API_KEY,
  baseURL: 'https://integrate.api.nvidia.com/v1',
  timeout: 60000 
});

// BLINDAGEM TOTAL: Junta turnos seguidos do mesmo remetente para evitar o Erro 400 no Mixtral
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
  const { historico, customInstructions, memoryContext, pesquisaWeb, arquivoAnexo } = req.body;

  if (!historico || historico.length === 0) return res.status(400).json({ error: 'Histórico ausente.' });
  
  const historicoSanitizado = sanitizarHistorico(historico);
  const ultimaMensagem = historicoSanitizado.length > 0 ? historicoSanitizado[historicoSanitizado.length - 1].content : '';
  
  let dadosInternet = "Pesquisa inativa.";
  let decolagemVisaoTexto = "";

  try {
    // 🎨 FLUXO 1: GERADOR DE IMAGEM DA NVIDIA (SDXL)
    if (ultimaMensagem.toLowerCase().startsWith('/gerar') || ultimaMensagem.toLowerCase().startsWith('/imagem')) {
      const promptImagem = ultimaMensagem.replace(/^\/(gerar|imagem)\s*/i, '');
      if (!promptImagem) {
        return res.json({ respostaFinal: "Especifique o que deseja gerar. Ex: `/gerar um cacto`", auditoria: { deepseek: "N/A", gemma: "N/A", llama8b: "N/A", webRaw: "N/A" } });
      }
      const responseImg = await nvidia.images.generate({
        model: "stabilityai/stable-diffusion-xl",
        prompt: promptImagem,
        response_format: "url"
      });
      return res.json({
        respostaFinal: `🎨 Imagem gerada com sucesso para **"${promptImagem}"**:\n\n![Imagem Gerada](${responseImg.data[0].url})`,
        auditoria: { deepseek: "Sucesso SDXL", gemma: "N/A", llama8b: "N/A", webRaw: "N/A" }
      });
    }

    // 👁️ FLUXO 2: PROCESSADOR DE VISÃO COMPUTACIONAL (Llama 3.2 Vision NIM)
    if (arquivoAnexo && arquivoAnexo.tipo === 'imagem') {
      console.log(`[Cactus-Vision] Decodificando dados da imagem compactada...`);
      try {
        const chamadaMapeamento = await nvidia.chat.completions.create({
          model: "meta/llama-3.2-11b-vision-instruct",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "Você é os olhos do Cactus. Descreva de forma extremamente detalhada, exaustiva e completa tudo o que está visível nesta imagem: transcreva textos, números, fórmulas, títulos de slides, elementos de gráficos, tabelas e fluxogramas científicos para que modelos textuais puros compreendam o arquivo perfeitamente." },
                { type: "image_url", image_url: { url: arquivoAnexo.conteudo } }
              ]
            }
          ]
        });
        decolagemVisaoTexto = chamadaMapeamento.choices?.[0]?.message?.content || "";
        console.log(`[Cactus-Vision] Mapeamento concluído com sucesso.`);
      } catch (errVision) {
        console.error("Erro na API de Visão:", errVision);
        decolagemVisaoTexto = "Erro técnico ao extrair os dados visuais do arquivo anexo.";
      }
    }

    // 🧠 ARQUITETURA DA DIRETRIZ MASTER UNIFICADA
    let textoInstrucaoSistema = "Seu nome é Cactus. Você é um assistente de inteligência artificial avançado, forte, resiliente e prestativo. Nunca diga que você é o DeepSeek, Mistral, Google, Gemma ou Llama. Se o usuário perguntar seu nome, quem criou você ou onde você está rodando, responda sempre com orgulho que você é o Cactus e que foi projetado de forma personalizada como um agregador inteligente de alto nível.";

    if (memoryContext) textoInstrucaoSistema += `\n\n[MEMÓRIA ATIVA SOBRE O USUÁRIO]:\n${memoryContext}`;
    if (customInstructions) textoInstrucaoSistema += `\n\n[INSTRUÇÕES ESTREITAS DE ESTILO]:\n${customInstructions}`;
    
    // Alimenta o ringue de modelos com os dados reais extraídos da foto!
    if (decolagemVisaoTexto) {
      textoInstrucaoSistema += `\n\n[IMAGEM ANEXADA PELO USUÁRIO (TEXTOS E DADOS EXTRAÍDOS DA FOTO)]:\n${decolagemVisaoTexto}`;
    }
    if (arquivoAnexo && arquivoAnexo.tipo === 'texto') {
      textoInstrucaoSistema += `\n\n[CONTEÚDO DO ARQUIVO DE TEXTO ANEXADO (${arquivoAnexo.nome})]:\n${arquivoAnexo.conteudo}`;
    }
    if (pesquisaWeb) {
      dadosInternet = await buscarNaWeb(ultimaMensagem);
      textoInstrucaoSistema += `\n\n[CONTEXTO ATUALIZADO DA INTERNET EM TEM REAL (ANO 2026)]:\n${dadosInternet}`;
    }

    const promptFinalModelos = [
      { role: "system", content: textoInstrucaoSistema },
      ...historicoSanitizado
    ];

    // DISPARO PARALELO DO RINGUE DE MODELOS SPECIALISTAS
    const [chamadaDeepSeek, chamadaMixtral, chamadaLlama8b] = await Promise.all([
      nvidia.chat.completions.create({ model: "deepseek-ai/deepseek-v4-flash", messages: promptFinalModelos }).catch(err => ({ error: true, message: err.message })),
      nvidia.chat.completions.create({ model: "mistralai/mixtral-8x7b-instruct-v0.1", messages: promptFinalModelos }).catch(err => ({ error: true, message: err.message })),
      nvidia.chat.completions.create({ model: "meta/llama-3.1-8b-instruct", messages: promptFinalModelos }).catch(err => ({ error: true, message: err.message }))
    ]);

    const respostaDeepSeek = chamadaDeepSeek.error ? `Erro: ${chamadaDeepSeek.message}` : (chamadaDeepSeek.choices?.[0]?.message?.content || "Vazio.");
    const respostaMixtral = chamadaMixtral.error ? `Erro: ${chamadaMixtral.message}` : (chamadaMixtral.choices?.[0]?.message?.content || "Vazio.");
    const respostaLlama8b = chamadaLlama8b.error ? `Erro: ${chamadaLlama8b.message}` : (chamadaLlama8b.choices?.[0]?.message?.content || "Vazio.");

    const promptJuiz = `
Você é o avaliador oficial do Cactus. Escolha a melhor, mais precisa e mais didática resposta entre as três opções fornecidas. 
Priorize a opção que explicou com excelência os dados contidos no contexto do sistema e respondeu ao comando do usuário.
Retorne APENAS o texto puro da escolhida, sem metalinguagem ou justificativas.

Última Pergunta: "${ultimaMensagem}"

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
      auditoria: { deepseek: respostaDeepSeek, gemma: respostaMixtral, llama8b: respostaLlama8b, webRaw: arquivoAnexo ? `Mapeamento Concluído: ${arquivoAnexo.nome}` : "Nenhum anexo." }
    });

  } catch (error) {
    console.error('Erro inesperado no servidor:', error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[Cactus] Central Multimodal ativa na porta ${PORT}`));const express = require('express');
const cors = require('cors');
const { OpenAI } = require('openai');

const app = report = express();

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static('public'));

const nvidia = new OpenAI({
  apiKey: process.env.NVIDIA_API_KEY,
  baseURL: 'https://integrate.api.nvidia.com/v1',
  timeout: 60000 
});

// BLINDAGEM TOTAL: Junta turnos seguidos do mesmo remetente para evitar o Erro 400 no Mixtral
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
  const { historico, customInstructions, memoryContext, pesquisaWeb, arquivoAnexo } = req.body;

  if (!historico || historico.length === 0) return res.status(400).json({ error: 'Histórico ausente.' });
  
  const historicoSanitizado = sanitizarHistorico(historico);
  const ultimaMensagem = historicoSanitizado.length > 0 ? historicoSanitizado[historicoSanitizado.length - 1].content : '';
  
  let dadosInternet = "Pesquisa inativa.";
  let decolagemVisaoTexto = "";

  try {
    // 🎨 FLUXO 1: GERADOR DE IMAGEM DA NVIDIA (SDXL)
    if (ultimaMensagem.toLowerCase().startsWith('/gerar') || ultimaMensagem.toLowerCase().startsWith('/imagem')) {
      const promptImagem = ultimaMensagem.replace(/^\/(gerar|imagem)\s*/i, '');
      if (!promptImagem) {
        return res.json({ respostaFinal: "Especifique o que deseja gerar. Ex: `/gerar um cacto`", auditoria: { deepseek: "N/A", gemma: "N/A", llama8b: "N/A", webRaw: "N/A" } });
      }
      const responseImg = await nvidia.images.generate({
        model: "stabilityai/stable-diffusion-xl",
        prompt: promptImagem,
        response_format: "url"
      });
      return res.json({
        respostaFinal: `🎨 Imagem gerada com sucesso para **"${promptImagem}"**:\n\n![Imagem Gerada](${responseImg.data[0].url})`,
        auditoria: { deepseek: "Sucesso SDXL", gemma: "N/A", llama8b: "N/A", webRaw: "N/A" }
      });
    }

    // 👁️ FLUXO 2: PROCESSADOR DE VISÃO COMPUTACIONAL (Llama 3.2 Vision NIM)
    if (arquivoAnexo && arquivoAnexo.tipo === 'imagem') {
      console.log(`[Cactus-Vision] Decodificando dados da imagem compactada...`);
      try {
        const chamadaMapeamento = await nvidia.chat.completions.create({
          model: "meta/llama-3.2-11b-vision-instruct",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "Você é os olhos do Cactus. Descreva de forma extremamente detalhada, exaustiva e completa tudo o que está visível nesta imagem: transcreva textos, números, fórmulas, títulos de slides, elementos de gráficos, tabelas e fluxogramas científicos para que modelos textuais puros compreendam o arquivo perfeitamente." },
                { type: "image_url", image_url: { url: arquivoAnexo.conteudo } }
              ]
            }
          ]
        });
        decolagemVisaoTexto = chamadaMapeamento.choices?.[0]?.message?.content || "";
        console.log(`[Cactus-Vision] Mapeamento concluído com sucesso.`);
      } catch (errVision) {
        console.error("Erro na API de Visão:", errVision);
        decolagemVisaoTexto = "Erro técnico ao extrair os dados visuais do arquivo anexo.";
      }
    }

    // 🧠 ARQUITETURA DA DIRETRIZ MASTER UNIFICADA
    let textoInstrucaoSistema = "Seu nome é Cactus. Você é um assistente de inteligência artificial avançado, forte, resiliente e prestativo. Nunca diga que você é o DeepSeek, Mistral, Google, Gemma ou Llama. Se o usuário perguntar seu nome, quem criou você ou onde você está rodando, responda sempre com orgulho que você é o Cactus e que foi projetado de forma personalizada como um agregador inteligente de alto nível.";

    if (memoryContext) textoInstrucaoSistema += `\n\n[MEMÓRIA ATIVA SOBRE O USUÁRIO]:\n${memoryContext}`;
    if (customInstructions) textoInstrucaoSistema += `\n\n[INSTRUÇÕES ESTREITAS DE ESTILO]:\n${customInstructions}`;
    
    // Alimenta o ringue de modelos com os dados reais extraídos da foto!
    if (decolagemVisaoTexto) {
      textoInstrucaoSistema += `\n\n[IMAGEM ANEXADA PELO USUÁRIO (TEXTOS E DADOS EXTRAÍDOS DA FOTO)]:\n${decolagemVisaoTexto}`;
    }
    if (arquivoAnexo && arquivoAnexo.tipo === 'texto') {
      textoInstrucaoSistema += `\n\n[CONTEÚDO DO ARQUIVO DE TEXTO ANEXADO (${arquivoAnexo.nome})]:\n${arquivoAnexo.conteudo}`;
    }
    if (pesquisaWeb) {
      dadosInternet = await buscarNaWeb(ultimaMensagem);
      textoInstrucaoSistema += `\n\n[CONTEXTO ATUALIZADO DA INTERNET EM TEM REAL (ANO 2026)]:\n${dadosInternet}`;
    }

    const promptFinalModelos = [
      { role: "system", content: textoInstrucaoSistema },
      ...historicoSanitizado
    ];

    // DISPARO PARALELO DO RINGUE DE MODELOS SPECIALISTAS
    const [chamadaDeepSeek, chamadaMixtral, chamadaLlama8b] = await Promise.all([
      nvidia.chat.completions.create({ model: "deepseek-ai/deepseek-v4-flash", messages: promptFinalModelos }).catch(err => ({ error: true, message: err.message })),
      nvidia.chat.completions.create({ model: "mistralai/mixtral-8x7b-instruct-v0.1", messages: promptFinalModelos }).catch(err => ({ error: true, message: err.message })),
      nvidia.chat.completions.create({ model: "meta/llama-3.1-8b-instruct", messages: promptFinalModelos }).catch(err => ({ error: true, message: err.message }))
    ]);

    const respostaDeepSeek = chamadaDeepSeek.error ? `Erro: ${chamadaDeepSeek.message}` : (chamadaDeepSeek.choices?.[0]?.message?.content || "Vazio.");
    const respostaMixtral = chamadaMixtral.error ? `Erro: ${chamadaMixtral.message}` : (chamadaMixtral.choices?.[0]?.message?.content || "Vazio.");
    const respostaLlama8b = chamadaLlama8b.error ? `Erro: ${chamadaLlama8b.message}` : (chamadaLlama8b.choices?.[0]?.message?.content || "Vazio.");

    const promptJuiz = `
Você é o avaliador oficial do Cactus. Escolha a melhor, mais precisa e mais didática resposta entre as três opções fornecidas. 
Priorize a opção que explicou com excelência os dados contidos no contexto do sistema e respondeu ao comando do usuário.
Retorne APENAS o texto puro da escolhida, sem metalinguagem ou justificativas.

Última Pergunta: "${ultimaMensagem}"

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
      auditoria: { deepseek: respostaDeepSeek, gemma: respostaMixtral, llama8b: respostaLlama8b, webRaw: arquivoAnexo ? `Mapeamento Concluído: ${arquivoAnexo.nome}` : "Nenhum anexo." }
    });

  } catch (error) {
    console.error('Erro inesperado no servidor:', error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[Cactus] Central Multimodal ativa na porta ${PORT}`));
