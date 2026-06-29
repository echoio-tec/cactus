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
  timeout: 30000 // Otimizado para falha rápida (30 segundos max)
});

function encapsularErroMódulo(nomeModelo) {
  return (err) => ({ error: true, message: `Módulo ${nomeModelo} offline: ${err.message}` });
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
    // 🎨 ENGINE DE RENDERIZAÇÃO GRÁFICA (STABLE DIFFUSION XL)
    if (ultimaMensagem.toLowerCase().startsWith('/gerar') || ultimaMensagem.toLowerCase().startsWith('/imagem')) {
      const promptImagem = ultimaMensagem.replace(/^\/(gerar|imagem)\s*/i, '');
      if (!promptImagem) return res.status(400).json({ error: "Especifique o que deseja gerar após o comando." });

      console.log(`[Cactus-Graphics] Gerando arte para: "${promptImagem}"`);
      try {
        const responseImg = await nvidia.images.generate({
          model: "stabilityai/stable-diffusion-xl",
          prompt: promptImagem
        });
        
        return res.json({
          respostaFinal: `🎨 Aqui está a renderização conceitual para **"${promptImagem}"**:\n\n![Imagem Gerada](${responseImg.data[0].url})`,
          auditoria: { deepseek: "Renderizado via SDXL", gemma: "N/A", llama8b: "N/A", webRaw: "Módulo Gráfico Concluído" }
        });
      } catch (errImg) {
        return res.json({
          respostaFinal: "⚠️ O microsserviço de renderização da NVIDIA está congestionado. Envie o comando novamente em instantes.",
          auditoria: { deepseek: `Erro: ${errImg.message}`, gemma: "N/A", llama8b: "N/A", webRaw: "Falha de renderização" }
        });
      }
    }

    // DIRETRIZ MASTER DO ECOSSISTEMA CACTUS
    let sistemaTexto = "Seu nome é Cactus. Você é um assistente de inteligência artificial avançado, forte, resiliente e prestativo. Nunca diga que você é o DeepSeek, Google, Gemma ou Llama. Responda sempre com orgulho que você é o Cactus e que foi projetado de forma personalizada como um agregador inteligente de alto nível.";

    if (memoryContext) sistemaTexto += `\n\n[MEMÓRIA ATIVA SOBRE O USUÁRIO]:\n${memoryContext}`;
    if (customInstructions) sistemaTexto += `\n\n[DIRETRIZES EXIGIDAS DE ESTILO]:\n${customInstructions}`;
    if (pesquisaWeb) {
      dadosInternet = await buscarNaWeb(ultimaMensagem);
      sistemaTexto += `\n\n[DADOS ATUALIZADOS DA INTERNET]:\n${dadosInternet}`;
    }

    const promptTextualPuro = [{ role: "system", content: sistemaTexto }, ...historicoSanitizado];
    let chamadaVision, chamadaDeepSeek, chamadaLlama8b;

    if (arquivoAnexo && arquivoAnexo.tipo === 'imagem') {
      console.log("[Cactus-Core] Processando pipeline multimodal de visão.");
      const promptVisaoPuro = [
        {
          role: "user",
          content: [
            { type: "text", text: `Você é a capacidade visual do Cactus. Analise meticulosamente esta imagem e extraia dados, tabelas e textos para responder à ordem: "${ultimaMensagem}"` },
            { type: "image_url", image_url: { url: arquivoAnexo.conteudo } }
          ]
        }
      ];

      const promptTextoCego = [
        { role: "system", content: sistemaTexto + "\n\n[ALERTA]: O usuário enviou uma imagem agora. Como você não possui olhos neste barramento, informe estritamente que está aguardando o relatório visual do Filtro 1 do Cactus." },
        ...historicoSanitizado
      ];

      [chamadaVision, chamadaDeepSeek, chamadaLlama8b] = await Promise.all([
        nvidia.chat.completions.create({ model: "meta/llama-3.2-11b-vision-instruct", messages: promptVisaoPuro }).catch(encapsularErroMódulo("Llama-Vision")),
        nvidia.chat.completions.create({ model: "deepseek-ai/deepseek-v4-flash", messages: promptTextoCego }).catch(encapsularErroMódulo("DeepSeek-Flash")),
        nvidia.chat.completions.create({ model: "meta/llama-3.1-8b-instruct", messages: promptTextoCego }).catch(encapsularErroMódulo("Llama-8B"))
      ]);
    } else {
      console.log("[Cactus-Core] Processando pipeline textual padrão.");
      [chamadaVision, chamadaDeepSeek, chamadaLlama8b] = await Promise.all([
        nvidia.chat.completions.create({ model: "deepseek-ai/deepseek-v4-flash", messages: promptTextualPuro }).catch(encapsularErroMódulo("DeepSeek-Flash")),
        nvidia.chat.completions.create({ model: "meta/llama-3.1-8b-instruct", messages: promptTextualPuro }).catch(encapsularErroMódulo("Llama-8B")),
        nvidia.chat.completions.create({ model: "meta/llama-3.1-70b-instruct", messages: promptTextualPuro }).catch(encapsularErroMódulo("Llama-70B"))
      ]);
    }

    const txt1 = chamadaVision.error ? chamadaVision.message : (chamadaVision.choices?.[0]?.message?.content || "Vazio.");
    const txt2 = chamadaDeepSeek.error ? chamadaDeepSeek.message : (chamadaDeepSeek.choices?.[0]?.message?.content || "Vazio.");
    const txt3 = chamadaLlama8b.error ? chamadaLlama8b.message : (chamadaLlama8b.choices?.[0]?.message?.content || "Vazio.");

    // ⚡ MODELO JUIZ ATUALIZADO PARA LLAMA 3.3 70B (40% MAIS RÁPIDO)
    const promptJuiz = `
Você é o Juiz do Cactus. Avalie as três respostas e retorne a melhor, mais completa e profunda resposta estruturada em PORTUGUÊS (PT-BR).
Se houver uma imagem em análise, dê preferência absoluta para a Opção 1. Retorne APENAS a resposta vencedora limpa, sem metalinguagem.

Pergunta: "${ultimaMensagem}"
Opção 1: ${txt1}
Opção 2: ${txt2}
Opção 3: ${txt3}
    `;

    const chamadaJuiz = await nvidia.chat.completions.create({
      model: "meta/llama-3.3-70b-instruct",
      messages: [{ role: "user", content: promptJuiz }]
    }).catch(() => null);

    const respostaFinalConsolidada = (chamadaJuiz && chamadaJuiz.choices?.[0]?.message?.content) ? chamadaJuiz.choices[0].message.content : txt1;

    res.json({
      respostaFinal: respostaFinalConsolidada,
      auditoria: { deepseek: txt1, gemma: txt2, llama8b: txt3, webRaw: arquivoAnexo ? `Fusão Multimodal Ativa: ${arquivoAnexo.nome}` : "Texto Puro" }
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[Cactus Engine] Ativo e otimizado na porta ${PORT}`));
