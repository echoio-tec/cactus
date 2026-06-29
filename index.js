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

// Junta turnos seguidos do mesmo remetente para evitar erros de barramento no Mixtral/Gemma
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
    // GERAÇÃO DE IMAGEM DESATIVADA CONFORME DIRETRIZ
    if (ultimaMensagem.toLowerCase().startsWith('/gerar') || ultimaMensagem.toLowerCase().startsWith('/imagem')) {
      return res.json({ respostaFinal: "Geração de imagens desativada pelo administrador temporariamente.", auditoria: { deepseek: "N/A", gemma: "N/A", llama8b: "N/A", webRaw: "N/A" } });
    }

    // CONFIGURAÇÃO DA DIRETRIZ MASTER DO CACTUS
    let sistemaTexto = "Seu nome é Cactus. Você é um assistente de inteligência artificial avançado, forte, resiliente e prestativo. Nunca diga que você é o DeepSeek, Mistral, Google, Gemma ou Llama. Se o usuário perguntar seu nome, quem criou você ou onde você está rodando, responda sempre com orgulho que você é o Cactus.";

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

    let chamadaDeepSeek, chamadaGemma, chamadaLlama8b;

    if (arquivoAnexo && arquivoAnexo.tipo === 'imagem') {
      console.log("[Cactus-Engine] Disparando ringue analítico com suporte a imagem.");
      
      const promptVisaoPuro = [
        { role: "system", content: sistemaTexto + "\n\nVocê é a capacidade de visão do Cactus. Sua tarefa obrigatória e principal é ler todo o texto (OCR), marcas, títulos e dados presentes na imagem enviada e responder estritamente em PORTUGUÊS (PT-BR)." },
        {
          role: "user",
          content: [
            { type: "text", text: `O usuário anexou uma imagem e deu a seguinte instrução: "${ultimaMensagem}". ATENÇÃO: Faça a leitura detalhada das palavras escritas na imagem e use esses dados textuais reais para responder à instrução do usuário de forma didática e completa.` },
            { type: "image_url", image_url: { url: arquivoAnexo.conteudo } }
          ]
        }
      ];

      const promptTextoCego = [
        { role: "system", content: sistemaTexto + "\n\n[ALERTA RÍGIDO]: O usuário enviou uma imagem agora. Como você é um modelo puramente textual e não tem acesso aos olhos de visão do Cactus, responda estritamente avisando que não possui acesso direto à imagem e que está aguardando a consolidação do filtro de visão do Cactus." },
        ...historicoSanitizado
      ];

      [chamadaDeepSeek, chamadaGemma, chamadaLlama8b] = await Promise.all([
        nvidia.chat.completions.create({ model: "meta/llama-3.2-11b-vision-instruct", messages: promptVisaoPuro }).catch(err => ({ error: true, message: "Erro ao carregar módulo de visão." })),
        nvidia.chat.completions.create({ model: "google/gemma-2-27b-it", messages: promptTextoCego }).catch(err => ({ error: true, message: "Filtro Gemma instável." })),
        nvidia.chat.completions.create({ model: "meta/llama-3.1-8b-instruct", messages: promptTextoCego }).catch(err => ({ error: true, message: "Filtro Llama instável." }))
      ]);

    } else {
      console.log("[Cactus-Engine] Disparando ringue textual padrão.");
      [chamadaDeepSeek, chamadaGemma, chamadaLlama8b] = await Promise.all([
        nvidia.chat.completions.create({ model: "deepseek-ai/deepseek-v4-flash", messages: promptTextualPuro }).catch(err => ({ error: true, message: err.message })),
        nvidia.chat.completions.create({ model: "google/gemma-2-27b-it", messages: promptTextualPuro }).catch(err => ({ error: true, message: err.message })),
        nvidia.chat.completions.create({ model: "meta/llama-3.1-8b-instruct", messages: promptTextualPuro }).catch(err => ({ error: true, message: err.message }))
      ]);
    }

    // ⚡ CORREÇÃO DOS NOMES DAS VARIÁVEIS (ch vs ll corrigidos)
    const res1 = chamadaDeepSeek.error ? chamadaDeepSeek.message : (chamadaDeepSeek.choices?.[0]?.message?.content || "Vazio.");
    const res2 = chamadaGemma.error ? chamadaGemma.message : (chamadaGemma.choices?.[0]?.message?.content || "Vazio.");
    const res3 = chamadaLlama8b.error ? chamadaLlama8b.message : (chamadaLlama8b.choices?.[0]?.message?.content || "Vazio.");

    const promptJuiz = `
Você é o Juiz do Cactus. Avalie as três respostas e retorne a melhor e mais didática resposta estruturada em PORTUGUÊS (PT-BR).
Se houver uma imagem em jogo, dê total prioridade à Opção 1, contanto que ela descreva elementos visuais reais, pois as outras opções são cegas por design.
Retorne APENAS o texto limpo da escolhida, sem metalinguagem.

Pergunta: "${ultimaMensagem}"

Opção 1 (Especialista com Olhos): ${res1}
Opção 2 (Gemma Textual): ${res2}
Opção 3 (Llama Textual): ${res3}
    `;

    const chamadaJuiz = await nvidia.chat.completions.create({
      model: "meta/llama-3.1-70b-instruct",
      messages: [{ role: "user", content: promptJuiz }]
    }).catch(() => null);

    const respostaVencedora = (chamadaJuiz && !chamadaJuiz.error && chamadaJuiz.choices?.[0]?.message?.content) ? chamadaJuiz.choices[0].message.content : res1;

    res.json({
      respostaFinal: respostaVencedora,
      auditoria: { deepseek: res1, gemma: res2, llama8b: res3, webRaw: arquivoAnexo ? `Arquivo Processado: ${arquivoAnexo.nome}` : "Nenhum anexo." }
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[Cactus] Motor corrigido na porta ${PORT}`));
