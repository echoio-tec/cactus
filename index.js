const express = require('express');
const cors = require('cors');
const { OpenAI } = require('openai');

const app = express();

app.use(cors());
// 🚨 ESSENCIAL: Aumenta o limite para suportar o envio de imagens/arquivos em Base64
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static('public'));

const nvidia = new OpenAI({
  apiKey: process.env.NVIDIA_API_KEY,
  baseURL: 'https://integrate.api.nvidia.com/v1',
  timeout: 60000 
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
  const { historico, customInstructions, memoryContext, pesquisaWeb, arquivoAnexo } = req.body;

  if (!historico || historico.length === 0) return res.status(400).json({ error: 'Histórico ausente.' });
  const ultimaMensagem = historico[historico.length - 1].content;
  
  try {
    // 🎨 FLUXO 1: GERADOR DE IMAGEM DA NVIDIA (Se o usuário usar comandos como /gerar ou /imagem)
    if (ultimaMensagem.toLowerCase().startsWith('/gerar') || ultimaMensagem.toLowerCase().startsWith('/imagem')) {
      console.log(`[Cactus-Painel] Detectado comando de geração de imagem.`);
      const promptImagem = ultimaMensagem.replace(/^\/(gerar|imagem)\s*/i, '');
      
      if (!promptImagem) {
        return res.json({ respostaFinal: "Por favor, especifique o que deseja gerar. Exemplo: `/gerar um cacto neon no deserto`", auditoria: { deepseek: "N/A", gemma: "N/A", llama8b: "N/A", webRaw: "N/A" } });
      }

      const responseImg = await nvidia.images.generate({
        model: "stabilityai/stable-diffusion-xl",
        prompt: promptImagem,
        response_format: "url"
      });

      const urlGerada = responseImg.data[0].url;
      return res.json({
        respostaFinal: `🎨 Aqui está a imagem que você pediu para eu gerar sobre **"${promptImagem}"**:\n\n![Imagem Gerada](${urlGerada})`,
        auditoria: { deepseek: "Imagem gerada via SDXL", gemma: "Sucesso", llama8b: "N/A", webRaw: "N/A" }
      });
    }

    // 🧠 FLUXO 2: PROCESSAMENTO TEXTUAL E MULTIMODAL (RINGUE DE IAS)
    let textoInstrucaoSistema = "Seu nome é Cactus. Você é um assistente de inteligência artificial avançado, forte, resiliente e prestativo. Nunca diga que você é o DeepSeek, Mistral, Google, Gemma ou Llama. Se o usuário perguntar seu nome, quem criou você ou onde você está rodando, responda sempre com orgulho que você é o Cactus e que foi projetado de forma personalizada como um agregador inteligente de alto nível.";

    if (memoryContext) textoInstrucaoSistema += `\n\n[MEMÓRIA ATIVA SOBRE O USUÁRIO]:\n${memoryContext}`;
    if (customInstructions) textoInstrucaoSistema += `\n\n[INSTRUÇÕES ESTREITAS DE ESTILO]:\n${customInstructions}`;
    
    if (pesquisaWeb) {
      const dadosInternet = await buscarNaWeb(ultimaMensagem);
      textoInstrucaoSistema += `\n\n[CONTEXTO ATUALIZADO DA INTERNET EM TEM REAL (ANO 2026)]:\n${dadosInternet}`;
    }

    // Estruturação do Prompt Base
    let promptFinalModelos = [{ role: "system", content: textoInstrucaoSistema }, ...historico];

    // Se houver um arquivo de texto/PDF limpo anexado pelo front-end
    if (arquivoAnexo && arquivoAnexo.tipo === 'texto') {
      promptFinalModelos.push({
        role: "system",
        content: `[CONTEÚDO DO ARQUIVO ANEXADO POR SEU USUÁRIO (${arquivoAnexo.nome})]:\n${arquivoAnexo.conteudo}`
      });
    }

    // Configuração das chamadas paralelas
    let chamadaDeepSeek, chamadaMixtral, chamadaLlama8b;

    // Se houver uma imagem anexada (Base64), acionamos o modelo de visão dedicado da NVIDIA
    if (arquivoAnexo && arquivoAnexo.tipo === 'imagem') {
      console.log(`[Cactus-Vision] Processando imagem analítica com modelo de visão NIM.`);
      
      const promptVisao = [
        { role: "system", content: textoInstrucaoSistema },
        {
          role: "user",
          content: [
            { type: "text", text: `Analise a imagem anexada e atenda à seguinte solicitação do usuário: ${ultimaMensagem}` },
            { type: "image_url", image_url: { url: arquivoAnexo.conteudo } }
          ]
        }
      ];

      // O modelo de Visão assume a execução paralela de ponta
      [chamadaDeepSeek, chamadaMixtral, chamadaLlama8b] = await Promise.all([
        nvidia.chat.completions.create({ model: "meta/llama-3.2-11b-vision-instruct", messages: promptVisao }).catch(err => ({ error: true, message: err.message })),
        nvidia.chat.completions.create({ model: "mistralai/mixtral-8x7b-instruct-v0.1", messages: promptFinalModelos }).catch(err => ({ error: true, message: err.message })),
        nvidia.chat.completions.create({ model: "meta/llama-3.1-8b-instruct", messages: promptFinalModelos }).catch(err => ({ error: true, message: err.message }))
      ]);
    } else {
      // Execução puramente textual padrão do ringue
      [chamadaDeepSeek, chamadaMixtral, chamadaLlama8b] = await Promise.all([
        nvidia.chat.completions.create({ model: "deepseek-ai/deepseek-v4-flash", messages: promptFinalModelos }).catch(err => ({ error: true, message: err.message })),
        nvidia.chat.completions.create({ model: "mistralai/mixtral-8x7b-instruct-v0.1", messages: promptFinalModelos }).catch(err => ({ error: true, message: err.message })),
        nvidia.chat.completions.create({ model: "meta/llama-3.1-8b-instruct", messages: promptFinalModelos }).catch(err => ({ error: true, message: err.message }))
      ]);
    }

    const respostaDeepSeek = chamadaDeepSeek.error ? `Erro: ${chamadaDeepSeek.message}` : (chamadaDeepSeek.choices?.[0]?.message?.content || "Vazio.");
    const respostaMixtral = chamadaMixtral.error ? `Erro: ${chamadaMixtral.message}` : (chamadaMixtral.choices?.[0]?.message?.content || "Vazio.");
    const respostaLlama8b = chamadaLlama8b.error ? `Erro: ${chamadaLlama8b.message}` : (chamadaLlama8b.choices?.[0]?.message?.content || "Vazio.");

    // Prompt do Juiz avaliador do ecossistema Cactus
    const promptJuiz = `
Você é o avaliador oficial do Cactus. Escolha a melhor, mais precisa e mais completa resposta entre as três opções fornecidas. 
Priorize a opção que assumiu perfeitamente a identidade do Cactus, mantendo o tom profissional e sem expor marcas externas das APIs.
Retorne APENAS o texto da escolhida, sem adendos ou justificativas.

Última Pergunta: "${ultimaMensagem}"

Opção 1 (Análise Multimodal/Geral): ${respostaDeepSeek}
Opção 2 (Análise Textual Complementar): ${respostaMixtral}
Opção 3 (Filtro Alternativo): ${respostaLlama8b}
    `;

    const chamadaJuiz = await nvidia.chat.completions.create({
      model: "meta/llama-3.1-70b-instruct",
      messages: [{ role: "user", content: promptJuiz }]
    }).catch(err => ({ error: true, message: err.message }));

    const respostaVencedora = chamadaJuiz.error ? respostaDeepSeek : (chamadaJuiz.choices?.[0]?.message?.content || respostaDeepSeek);

    res.json({
      respostaFinal: respostaVencedora,
      auditoria: { deepseek: respostaDeepSeek, gemma: respostaMixtral, llama8b: respostaLlama8b, webRaw: arquivoAnexo ? `Arquivo anexado: ${arquivoAnexo.nome}` : "Nenhum arquivo." }
    });

  } catch (error) {
    console.error('Erro inesperado no servidor:', error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[Cactus-Multimodal] Ativo na porta ${PORT}`));
