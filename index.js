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
  timeout: 60000 // Aumentado para 60s para suportar processamento de imagens pesadas
});

// Higienização para impedir erro 400 (regras de alternância de histórico)
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
    // 🎨 GERADOR DE IMAGEM
    if (ultimaMensagem.toLowerCase().startsWith('/gerar') || ultimaMensagem.toLowerCase().startsWith('/imagem')) {
      const promptImagem = ultimaMensagem.replace(/^\/(gerar|imagem)\s*/i, '');
      if (!promptImagem) return res.json({ respostaFinal: "Especifique o prompt. Ex: `/gerar um cacto neon`" });
      
      const responseImg = await nvidia.images.generate({
        model: "stabilityai/sdxl-turbo",
        prompt: promptImagem,
        response_format: "url"
      });
      return res.json({
        respostaFinal: `🎨 Imagem gerada para **"${promptImagem}"**:\n\n![Imagem](${responseImg.data[0].url})`,
        auditoria: { deepseek: "Sucesso SDXL Turbo", gemma: "N/A", llama8b: "N/A", webRaw: "N/A" }
      });
    }

    // DIRETRIZ MASTER
    let sistemaTexto = "Seu nome é Cactus. Analista de IA de elite. Respostas profundas, didáticas e rigorosas. Use sempre português (PT-BR). Nunca mencione modelos externos como DeepSeek ou Llama.";
    if (memoryContext) sistemaTexto += `\n[MEMÓRIA]: ${memoryContext}`;
    if (customInstructions) sistemaTexto += `\n[ESTILO]: ${customInstructions}`;
    if (pesquisaWeb) {
      dadosInternet = await buscarNaWeb(ultimaMensagem);
      sistemaTexto += `\n[INTERNET]: ${dadosInternet}`;
    }

    const promptTextualPuro = [{ role: "system", content: sistemaTexto }, ...historicoSanitizado];

    // DEFINIÇÃO DOS AGENTES DO RINGUE
    let chamadaVision, chamadaDeepSeek, chamadaLlama8b;

    if (arquivoAnexo && arquivoAnexo.tipo === 'imagem') {
      console.log("[Cactus-Engine] Analisando imagem...");
      const promptVisaoPuro = [
        { role: "system", content: sistemaTexto + "\n\nVocê é o olho do Cactus. Transcreva todo o texto e analise visualmente a imagem." },
        { role: "user", content: [
            { type: "text", text: `Analise a imagem: "${ultimaMensagem}"` },
            { type: "image_url", image_url: { url: arquivoAnexo.conteudo } }
        ]}
      ];

      [chamadaVision, chamadaDeepSeek, chamadaLlama8b] = await Promise.all([
        nvidia.chat.completions.create({ model: "meta/llama-3.2-11b-vision-instruct", messages: promptVisaoPuro }).catch(err => ({ error: true, message: "Erro Visão: " + err.message })),
        nvidia.chat.completions.create({ model: "deepseek-ai/deepseek-v4-flash", messages: promptTextualPuro }).catch(err => ({ error: true, message: err.message })),
        nvidia.chat.completions.create({ model: "meta/llama-3.1-8b-instruct", messages: promptTextualPuro }).catch(err => ({ error: true, message: err.message }))
      ]);
    } else {
      [chamadaVision, chamadaDeepSeek, chamadaLlama8b] = await Promise.all([
        nvidia.chat.completions.create({ model: "deepseek-ai/deepseek-v4-flash", messages: promptTextualPuro }).catch(err => ({ error: true, message: err.message })),
        nvidia.chat.completions.create({ model: "meta/llama-3.1-8b-instruct", messages: promptTextualPuro }).catch(err => ({ error: true, message: err.message })),
        nvidia.chat.completions.create({ model: "meta/llama-3.1-70b-instruct", messages: promptTextualPuro }).catch(err => ({ error: true, message: err.message }))
      ]);
    }

    // CORREÇÃO: Variáveis unificadas e seguras
    const resVision = chamadaVision.error ? chamadaVision.message : (chamadaVision.choices?.[0]?.message?.content || "Sem resposta.");
    const resDeep = chamadaDeepSeek.error ? chamadaDeepSeek.message : (chamadaDeepSeek.choices?.[0]?.message?.content || "Sem resposta.");
    const resLlama = chamadaLlama8b.error ? chamadaLlama8b.message : (chamadaLlama8b.choices?.[0]?.message?.content || "Sem resposta.");

    const promptJuiz = `
Você é o Juiz do Cactus. Escolha a resposta mais profissional e precisa em PORTUGUÊS. Retorne APENAS o texto.

Pergunta: "${ultimaMensagem}"
Opção 1 (Visão/Especialista): ${resVision}
Opção 2 (DeepSeek): ${resDeep}
Opção 3 (Llama): ${resLlama}
    `;

    const chamadaJuiz = await nvidia.chat.completions.create({
      model: "meta/llama-3.1-70b-instruct",
      messages: [{ role: "user", content: promptJuiz }]
    }).catch(() => null);

    const respostaVencedora = (chamadaJuiz && chamadaJuiz.choices?.[0]?.message?.content) ? chamadaJuiz.choices[0].message.content : resVision;

    res.json({
      respostaFinal: respostaVencedora,
      auditoria: { deepseek: resVision, gemma: resDeep, llama8b: resLlama, webRaw: arquivoAnexo ? `Arquivo Processado: ${arquivoAnexo.nome}` : "Nenhum anexo." }
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[Cactus] Operacional na porta ${PORT}`));
