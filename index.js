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
  timeout: 60000 // Aumentado para lidar com imagens pesadas
});

// Higienização de histórico para evitar repetições que travam o Mixtral
function sanitizarHistorico(historico) {
  const limpo = [];
  for (const msg of historico) {
    if (msg.role === 'system') continue;
    if (limpo.length === 0) {
      if (msg.role === 'user') limpo.push({ role: msg.role, content: msg.content });
    } else {
      const ultima = limpo[limpo.length - 1];
      if (ultima.role === msg.role) {
        ultima.content += `\n${msg.content}`; // Mescla mensagens seguidas do mesmo remetente
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
    if (!response.ok) return "Sem resultados na busca.";
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
    // 🎨 FLUXO 1: GERAÇÃO DE IMAGEM DA NVIDIA (SDXL)
    if (ultimaMensagem.toLowerCase().startsWith('/gerar') || ultimaMensagem.toLowerCase().startsWith('/imagem')) {
      const promptImagem = ultimaMensagem.replace(/^\/(gerar|imagem)\s*/i, '');
      if (!promptImagem) return res.json({ respostaFinal: "Especifique o prompt. Ex: `/gerar um cacto`" });
      const responseImg = await nvidia.images.generate({
        model: "stabilityai/stable-diffusion-xl",
        prompt: promptImagem,
        response_format: "url"
      });
      return res.json({
        respostaFinal: `🎨 Aqui está a imagem gerada para **"${promptImagem}"**:\n\n![Imagem Gerada](${responseImg.data[0].url})`,
        auditoria: { deepseek: "SDXL Executado", gemma: "N/A", llama8b: "N/A", webRaw: "N/A" }
      });
    }

    // 🧠 CONFIGURAÇÃO DA DIRETRIZ MASTER DO CACTUS
    let sistemaTexto = "Seu nome é Cactus. Você é um assistente de inteligência artificial avançado, forte, resiliente e prestativo. Nunca diga que você é o DeepSeek, Mistral, Google, Gemma ou Llama. Se o usuário perguntar seu nome, quem criou você ou onde você está rodando, responda sempre com orgulho que você é o Cactus.";

    if (memoryContext) sistemaTexto += `\n\n[MEMÓRIA ATIVA SOBRE O USUÁRIO]:\n${memoryContext}`;
    if (customInstructions) sistemaTexto += `\n\n[INSTRUÇÕES ESTREITAS DE ESTILO]:\n${customInstructions}`;
    if (pesquisaWeb) {
      dadosInternet = await buscarNaWeb(ultimaMensagem);
      sistemaTexto += `\n\n[CONTEÚDO ATUALIZADO DA INTERNET]:\n${dadosInternet}`;
    }

    const promptTextualPuro = [{ role: "system", content: sistemaTexto }, ...historicoSanitizado];

    // Se houver um arquivo de texto anexado (TXT, CSV, LOG)
    if (arquivoAnexo && arquivoAnexo.tipo === 'texto') {
      promptTextualPuro.push({ role: "system", content: `[CONTEÚDO DO ARQUIVO ANEXADO ${arquivoAnexo.nome}]:\n${arquivoAnexo.conteudo}` });
    }

    // 🧠 MONTAGEM DO RINGUE PARALELO (VISÃO VS TEXTO)
    let chamadaDeepSeek, chamadaMixtral, chamadaLlama8b;

    if (arquivoAnexo && arquivoAnexo.tipo === 'imagem') {
      console.log("[Cactus-Engine] Disparando ringue analítico com suporte a imagem.");
      
      const promptVisaoPuro = [
        { role: "system", content: sistemaTexto + "\n\nVocê é os olhos do Cactus. Analise a imagem anexada com extremo rigor científico, leia os textos e explique tudo." },
        {
          role: "user",
          content: [
            { type: "text", text: ultimaMensagem },
            { type: "image_url", image_url: { url: arquivoAnexo.conteudo } }
          ]
        }
      ];

      // Instrução para as IAs textuais não inventarem mentiras sobre a imagem que elas não veem
      const promptTextoCego = [
        { role: "system", content: sistemaTexto + "\n\n[ALERTA]: O usuário enviou uma foto/imagem agora. Como você é um modelo puramente de texto e NÃO consegue ver arquivos visuais, limite-se a dizer estritamente que está aguardando a análise do filtro de visão especialista do Cactus, ou faça um comentário neutro. JAMAIS invente dados ou use contextos antigos para adivinhar a imagem." },
        ...historicoSanitizado
      ];

      // Disparo simultâneo (O modelo de visão corre junto com os textuais)
      [chamadaDeepSeek, chamadaMixtral, chamadaLlama8b] = await Promise.all([
        nvidia.chat.completions.create({ model: "meta/llama-3.2-11b-vision-instruct", messages: promptVisaoPuro }).catch(err => ({ error: true, message: err.message })),
        nvidia.chat.completions.create({ model: "deepseek-ai/deepseek-v4-flash", messages: promptTextoCego }).catch(err => ({ error: true, message: err.message })),
        nvidia.chat.completions.create({ model: "meta/llama-3.1-8b-instruct", messages: promptTextoCego }).catch(err => ({ error: true, message: err.message }))
      ]);

    } else {
      // Fluxo puramente textual padrão
      console.log("[Cactus-Engine] Disparando ringue textual padrão.");
      [chamadaDeepSeek, chamadaMixtral, chamadaLlama8b] = await Promise.all([
        nvidia.chat.completions.create({ model: "deepseek-ai/deepseek-v4-flash", messages: promptTextualPuro }).catch(err => ({ error: true, message: err.message })),
        nvidia.chat.completions.create({ model: "mistralai/mixtral-8x7b-instruct-v0.1", messages: promptTextualPuro }).catch(err => ({ error: true, message: err.message })),
        nvidia.chat.completions.create({ model: "meta/llama-3.1-8b-instruct", messages: promptTextualPuro }).catch(err => ({ error: true, message: err.message }))
      ]);
    }

    const res1 = chamadaDeepSeek.error ? chamadaDeepSeek.message : (chamadaDeepSeek.choices?.[0]?.message?.content || "Sem resposta.");
    const res2 = chamadaMixtral.error ? chamadaMixtral.message : (chamadaMixtral.choices?.[0]?.message?.content || "Sem resposta.");
    const res3 = chamadaLlama8b.error ? chamadaLlama8b.message : (chamadaLlama8b.choices?.[0]?.message?.content || "Sem resposta.");

    // 🏆 O VEREDITO DO JUIZ (Llama 70B escolhe a melhor resposta)
    const promptJuiz = `
Você é o Juiz do Cactus. Avalie as três respostas e escolha a melhor, mais completa e didática que responda estritamente em PORTUGUÊS (PT-BR) ao comando do usuário.
Se houver uma imagem no contexto, priorize a resposta do Filtro 1 (que possui capacidade de visão), pois os outros filtros são cegos e podem ter alucinado ou se omitido corretamente.
Retorne APENAS o texto puro da escolhida, sem metalinguagem ou justificativas.

Pergunta do Usuário: "${ultimaMensagem}"

Opção 1 (Especialista/Visão): ${res1}
Opção 2: ${res2}
Opção 3: ${res3}
    `;

    const chamadaJuiz = await nvidia.chat.completions.create({
      model: "meta/llama-3.1-70b-instruct",
      messages: [{ role: "user", content: promptJuiz }]
    }).catch(err => ({ error: true, message: err.message }));

    const respostaVencedora = chamadaJuiz.error ? res1 : (chamadaJuiz.choices?.[0]?.message?.content || res1);

    res.json({
      respostaFinal: respostaVencedora,
      auditoria: { deepseek: res1, gemma: res2, llama8b: res3, webRaw: arquivoAnexo ? `Mapeamento Concluído: ${arquivoAnexo.nome}` : "Nenhum anexo." }
    });

  } catch (error) {
    console.error('Erro inesperado no servidor:', error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[Cactus] Ativo na porta ${PORT}`));
