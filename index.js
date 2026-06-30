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
  timeout: 30000
});

function tratarErroPromessa(modelo) {
  return (err) => ({ error: true, message: `Módulo ${modelo} offline ou indisponível: ${err.message}` });
}

// 🌾 BANCO DE ANCORAGEM ZOOTÉCNICA E AGRONÉGOCIO (MOCK RAG)
const BASE_CONHECIMENTO_AGRO = {
  nutricao_aves: "Tabela Técnica (Embrapa/NRC): Frangos de corte na fase inicial (1 a 21 dias) exigem: Energia Metabolizável: 2.950 a 3.000 kcal/kg. Proteína Bruta: 21% a 22%. Lisina Digestível: 1,22%. Metionina Digestível: 0,49%. Cálcio: 0,92%. Fósforo Disponível: 0,43%.",
  nutricao_bovinos: "Padrão de Confinamento Bovino: Relação volumoso:concentrado para terminação geralmente varia de 20:80 a 10:90. Exigência média de MS (Matéria Seca): 2,3% a 2,5% do Peso Vivo (PV). Ganho de peso esperado em dietas de alto grão: 1,4 kg a 1,8 kg/dia.",
  fertilidade_solo: "Recomendações de Fertilidade (Semiárido/Zinco): O nível crítico de Zinco (Zn) no solo pelo extrator Mehlich-1 é de 1,0 a 1,2 mg/dm³. Deficiências em plantas causam encurtamento de entrenós (rosetamento) e clorose listrada interveinal. Fontes: Sulfato de Zinco (20-22% Zn) ou Óxido de Zinco (50-80% Zn).",
  pastagem: "Manejo de Capim-Panicum (Mombaça/Colonião): Altura de entrada no pasto: 90 cm. Altura de saída (resíduo): 30 a 40 cm. Período de descanso médio no período chuvoso: 28 a 32 dias. Superar a altura de entrada reduz o valor nutritivo devido ao alongamento de colmo."
};

function recuperarContextoZootecnico(pergunta) {
  const p = pergunta.toLowerCase();
  if (p.includes("ave") || p.includes("frango") || p.includes("pintinho")) return `\n\n[RAG LOCAL - NUTRIÇÃO AVES]: ${BASE_CONHECIMENTO_AGRO.nutricao_aves}`;
  if (p.includes("bovino") || p.includes("boi") || p.includes("vaca") || p.includes("confinamento")) return `\n\n[RAG LOCAL - BOVINOCULTURA]: ${BASE_CONHECIMENTO_AGRO.nutricao_bovinos}`;
  if (p.includes("solo") || p.includes("zinco") || p.includes("adub") || p.includes("deficiência")) return `\n\n[RAG LOCAL - FERTILIDADE]: ${BASE_CONHECIMENTO_AGRO.fertilidade_solo}`;
  if (p.includes("pasto") || p.includes("capim") || p.includes("mombaça") || p.includes("lotação")) return `\n\n[RAG LOCAL - PASTAGENS]: ${BASE_CONHECIMENTO_AGRO.pastagem}`;
  return "";
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
    if (!process.env.TAVILY_API_KEY) return "Aviso: Chave da Tavily ausente nas variáveis de ambiente do Render.";
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: process.env.TAVILY_API_KEY, query: query, search_depth: "basic", max_results: 3 })
    });
    if (!response.ok) return "Sem resultados relevantes da busca externa.";
    const data = await response.json();
    return data.results ? data.results.map(r => `Título: ${r.title}\nConteúdo: ${r.content}`).join('\n\n') : "Nenhum resultado relevante encontrado.";
  } catch (err) {
    return `Falha na conexão com o barramento do Tavily: ${err.message}`;
  }
}

app.post('/api/perguntar', async (req, res) => {
  const { historico, customInstructions, memoryContext, pesquisaWeb, arquivoAnexo } = req.body;

  if (!historico || historico.length === 0) return res.status(400).json({ error: 'Histórico ausente.' });
  
  const historicoSanitizado = sanitizarHistorico(historico);
  const ultimaMensagem = historicoSanitizado.length > 0 ? historicoSanitizado[historicoSanitizado.length - 1].content : '';

  try {
    // 🎨 PIPELINE GRÁFICO INTELIGENTE COM AGENTE DE CONTINGÊNCIA ATIVO
    const textoMinusculo = ultimaMensagem.toLowerCase().trim();
    const ehPromptGrafico = textoMinusculo.startsWith('/gerar') || 
                            textoMinusculo.startsWith('/imagem') || 
                            textoMinusculo.startsWith('gerar uma imagem') || 
                            textoMinusculo.startsWith('gerar imagem') ||
                            textoMinusculo.startsWith('desenhe') ||
                            textoMinusculo.startsWith('crie uma imagem');

    if (ehPromptGrafico) {
      const promptImagem = ultimaMensagem
        .replace(/^\/(gerar|imagem)\s*/i, '')
        .replace(/^(gerar uma imagem|gerar imagem|desenhe|crie uma imagem de|crie uma imagem)\s*/i, '')
        .trim();

      if (!promptImagem) return res.status(400).json({ error: "Especifique o cenário descritivo da imagem." });

      console.log(`[Cactus-Graphics] Tentando renderização primária via NVIDIA NIM: "${promptImagem}"`);
      try {
        // Tenta o cluster padrão ouro da NVIDIA
        const responseImg = await nvidia.images.generate({
          model: "stabilityai/stable-diffusion-xl",
          prompt: promptImagem
        });
        
        return res.json({
          respostaFinal: `🎨 Aqui está a imagem gerada para **"${promptImagem}"**:\n\n![Imagem Gerada](${responseImg.data[0].url})`,
          auditoria: { deepseek: "Renderizado via SDXL (NVIDIA)", gemma: "N/A", llama8b: "N/A", webRaw: "Barramento Principal Ativo" }
        });
      } catch (errImg) {
        // 🚨 CIRCUITO DE CONTINGÊNCIA AUTOMÁTICO (Caso a API KEY dê B.O, entra aqui imediatamente)
        console.warn(`[Cactus-Graphics] Falha na NVIDIA NIM (${errImg.message}). Acionando barramento de reserva Pollinations...`);
        
        // Geração limpa, livre de chaves, ilimitada e em alta definição (1024x1024)
        const urlReserva = `https://image.pollinations.ai/p/${encodeURIComponent(promptImagem)}?width=1024&height=1024&seed=${Date.now()}&enhance=true`;
        
        return res.json({
          respostaFinal: `🎨 Here is your image! O Cactus contornou com sucesso uma instabilidade na cota do servidor secundário e renderizou **"${promptImagem}"** através do barramento de reserva:\n\n![Imagem Gerada](${urlReserva})`,
          auditoria: { 
            deepseek: `Erro NVIDIA: ${errImg.message}`, 
            gemma: "Circuito de Reserva Ativado", 
            llama8b: "Engine Flux-Pollinations Ativa", 
            webRaw: "Módulo Gráfico Blindado Contra Quedas" 
          }
        });
      }
    }

    // 📝 RESOLUÇÃO DE CONTEXTOS TEXTUAIS
    let dadosInternet = "Pesquisa Web: Inativa.";
    if (pesquisaWeb) {
      dadosInternet = await buscarNaWeb(ultimaMensagem);
    }
    
    const dadosCientificosLocais = recuperarContextoZootecnico(ultimaMensagem);

    let sistemaTexto = "Seu nome é Cactus. Você é um assistente de inteligência artificial de elite, personalizado para responder de forma profunda, profissional e didática. Use sempre português (PT-BR) e honre sua identidade Cactus. Baseie-se estritamente nas evidências factuais injetadas para responder com precisão técnica.";

    if (memoryContext) sistemaTexto += `\n\n[MEMÓRIA DO USUÁRIO]:\n${memoryContext}`;
    if (customInstructions) sistemaTexto += `\n\n[DIRETRIZ DE ESTILO]:\n${customInstructions}`;
    if (pesquisaWeb) sistemaTexto += `\n\n[DADOS ATUALIZADOS DA INTERNET]:\n${dadosInternet}`;
    if (dadosCientificosLocais) sistemaTexto += `\n\n[DADOS CIENTÍFICOS LOCAL ANCORADO]:\n${dadosCientificosLocais}`;

    const promptTextualPuro = [{ role: "system", content: sistemaTexto }, ...historicoSanitizado];
    let chamadaFiltro1, chamadaFiltro2, chamadaFiltro3;

    if (arquivoAnexo && arquivoAnexo.tipo === 'imagem') {
      const promptVisaoPuro = [
        {
          role: "user",
          content: [
            { type: "text", text: `Você é a capacidade visual do Cactus. Analise meticulosamente a imagem com base no contexto do sistema e responda em PORTUGUÊS à solicitação: "${ultimaMensagem}"` },
            { type: "image_url", image_url: { url: arquivoAnexo.conteudo } }
          ]
        }
      ];

      const promptTextoCego = [
        { role: "system", content: sistemaTexto + "\n\n[AVISO]: O usuário enviou uma imagem. Você é o modelo de suporte de texto puro e não tem acesso aos olhos de visão do Cactus. Aguarde a consolidação do relatório visual." },
        ...historicoSanitizado
      ];

      [chamadaFiltro1, chamadaFiltro2, chamadaFiltro3] = await Promise.all([
        nvidia.chat.completions.create({ model: "meta/llama-3.2-11b-vision-instruct", messages: promptVisaoPuro }).catch(tratarErroPromessa("Llama-Vision")),
        nvidia.chat.completions.create({ model: "deepseek-ai/deepseek-v4-flash", messages: promptTextoCego }).catch(tratarErroPromessa("DeepSeek-Flash")),
        nvidia.chat.completions.create({ model: "meta/llama-3.1-8b-instruct", messages: promptTextoCego }).catch(tratarErroPromessa("Llama-8B"))
      ]);
    } else {
      [chamadaFiltro1, chamadaFiltro2, chamadaFiltro3] = await Promise.all([
        nvidia.chat.completions.create({ model: "deepseek-ai/deepseek-v4-flash", messages: promptTextualPuro }).catch(tratarErroPromessa("DeepSeek-Flash")),
        nvidia.chat.completions.create({ model: "meta/llama-3.1-8b-instruct", messages: promptTextualPuro }).catch(tratarErroPromessa("Llama-8B")),
        nvidia.chat.completions.create({ model: "meta/llama-3.1-70b-instruct", messages: promptTextualPuro }).catch(tratarErroPromessa("Llama-70B"))
      ]);
    }

    const txt1 = chamadaFiltro1.error ? chamadaFiltro1.message : (chamadaFiltro1.choices?.[0]?.message?.content || "Sem resposta.");
    const txt2 = llamadaFiltro2.error ? chamadaFiltro2.message : (chamadaFiltro2.choices?.[0]?.message?.content || "Sem resposta.");
    const txt3 = chamadaFiltro3.error ? chamadaFiltro3.message : (chamadaFiltro3.choices?.[0]?.message?.content || "Sem resposta.");

    const promptJuiz = `
Você é o Juiz do Cactus. Avalie as três opções de resposta e selecione ou consolide a melhor, mais completa e profunda resposta estruturada em PORTUGUÊS (PT-BR).
Garanta o cumprimento de dados factuais se houver relatórios de RAG local ou de internet inseridos no contexto do sistema.
Se houver uma imagem em análise, dê preferência absoluta à Opção 1 (Visão).
Retorne APENAS o texto puro da resposta consolidada, sem metalinguagem ou introduções de juiz.

Pergunta do Usuário: "${ultimaMensagem}"

Opção 1: ${txt1}
Opção 2: ${txt2}
Opção 3: ${txt3}
    `;

    const chamadaJuiz = await nvidia.chat.completions.create({
      model: "meta/llama-3.3-70b-instruct",
      messages: [{ role: "user", content: promptJuiz }]
    }).catch(() => null);

    const respostaFinalConsolidada = (chamadaJuiz && chamadaJuiz.choices?.[0]?.message?.content) ? chamadaJuiz.choices[0].message.content : txt1;

    let logRAG = "";
    if (dadosCientificosLocais) logRAG += `[Ancoragem Zootécnica] `;
    logRAG += pesquisaWeb ? `[Web Provedor]: ${dadosInternet.substring(0, 200)}...` : `[Pesquisa Web Inativa]`;

    res.json({
      respostaFinal: respostaFinalConsolidada,
      auditoria: { 
        deepseek: txt1, 
        gemma: txt2, 
        llama8b: txt3, 
        webRaw: logRAG 
      }
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[Cactus] Central unificada e à prova de falhas na porta ${PORT}`));
