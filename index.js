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

function encapsularErroModulo(nomeModelo) {
  return (err) => ({ error: true, message: `Módulo ${nomeModelo} offline: ${err.message}` });
}

// 🌾 BANCO DE ANCORAGEM ZOOTÉCNICA
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

function optimizarHistorico(historico) {
  const limpo = [];
  for (const msg of historico) {
    if (msg.role === 'system') continue;
    if (limpo.length === 0) {
      if (msg.role === 'user') limpo.push({ role: msg.role, content: msg.content });
    } else {
      const ultima = limpo[limpo.length - 1];
      if (ultima.role === msg.role) { ultima.content += `\n${msg.content}`; } 
      else { limpo.push({ role: msg.role, content: msg.content }); }
    }
  }
  return limpo;
}

async function buscarNaWeb(query) {
  try {
    if (!process.env.TAVILY_API_KEY) return "Aviso: Chave da Tavily ausente nas variáveis de ambiente.";
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: process.env.TAVILY_API_KEY, query: query, search_depth: "basic", max_results: 3 })
    });
    if (!response.ok) return "Sem resultados da busca externa.";
    const data = await response.json();
    return data.results ? data.results.map(r => `Título: ${r.title}\nConteúdo: ${r.content}`).join('\n\n') : "Nenhum resultado relevante encontrado.";
  } catch (err) {
    return `Falha na conexão com o provedor de busca: ${err.message}`;
  }
}

// ⚡ ENDPOINT UNIFICADO E RESTAURADO
app.post('/api/perguntar', async (req, res) => {
  // CORREÇÃO: pesquisaWeb adicionada de volta à destruturação do body
  const { historico, customInstructions, memoryContext, pesquisaWeb, arquivoAnexo } = req.body;

  if (!historico || historico.length === 0) return res.status(400).json({ error: 'Histórico ausente.' });
  
  const historicoSanitizado = optimizarHistorico(historico);
  const ultimaMensagem = historicoSanitizado.length > 0 ? historicoSanitizado[historicoSanitizado.length - 1].content : '';

  try {
    // GENERATOR GRÁFICO SDXL
    if (ultimaMensagem.toLowerCase().startsWith('/gerar') || ultimaMensagem.toLowerCase().startsWith('/imagem')) {
      const promptImagem = ultimaMensagem.replace(/^\/(gerar|imagem)\s*/i, '');
      if (!promptImagem) return res.status(400).json({ error: "Especifique o prompt gráfico." });
      try {
        const responseImg = await nvidia.images.generate({ model: "stabilityai/stable-diffusion-xl", prompt: promptImagem });
        return res.json({
          respostaFinal: `🎨 Imagem gerada para **"${promptImagem}"**:\n\n![Imagem](${responseImg.data[0].url})`,
          auditoria: { deepseek: "SDXL Ativo", gemma: "N/A", llama8b: "N/A", webRaw: "Geração de Mídia Isolada" }
        });
      } catch (e) {
        return res.json({ respostaFinal: "⚠️ Indisponibilidade temporária no cluster SDXL da NVIDIA.", auditoria: { deepseek: e.message, gemma: "N/A", llama8b: "N/A", webRaw: "Erro" } });
      }
    }

    // RESOLUÇÃO DE CONTEXTOS EXTERNOS
    let dadosInternet = "Pesquisa Web: Inativa.";
    if (pesquisaWeb) {
      console.log(`[Cactus-Web] Buscando dados em tempo real para: "${ultimaMensagem}"`);
      dadosInternet = await buscarNaWeb(ultimaMensagem);
    }
    
    const dadosCientificosLocais = recuperarContextoZootecnico(ultimaMensagem);

    // INJEÇÃO MASTER NO PROMPT DO SISTEMA
    let sistemaTexto = "Seu nome é Cactus. Você é um assistente de inteligência artificial avançado, forte, resiliente e prestativo. Nunca diga que você é o DeepSeek, Google, Gemma ou Llama. Responda sempre com orgulho que você é o Cactus. Use as informações dos blocos de contexto externo fornecidos para basear suas respostas com exatidão factual.";

    if (memoryContext) sistemaTexto += `\n\n[MEMÓRIA ATIVA SOBRE O USUÁRIO]:\n${memoryContext}`;
    if (customInstructions) sistemaTexto += `\n\n[DIRETRIZES DE ESTILO]:\n${customInstructions}`;
    if (pesquisaWeb) sistemaTexto += `\n\n[DADOS ATUALIZADOS DA INTERNET (TEMPO REAL)]:\n${dadosInternet}`;
    if (dadosCientificosLocais) sistemaTexto += `\n\n[DADOS CIENTÍFICOS LOCAL ANCORADO]:\n${dadosCientificosLocais}`;

    const promptTextualPuro = [{ role: "system", content: sistemaTexto }, ...historicoSanitizado];
    let chamadaFiltro1, chamadaFiltro2, chamadaFiltro3;

    // PIPELINE MULTIMODAL VS TEXTUAL
    if (arquivoAnexo && arquivoAnexo.tipo === 'imagem') {
      const promptVisaoPuro = [
        { role: "user", content: [
            { type: "text", text: `Analise a imagem com base no contexto fornecido pelo sistema: "${ultimaMensagem}"` },
            { type: "image_url", image_url: { url: arquivoAnexo.conteudo } }
        ]}
      ];
      const promptTextoCego = [{ role: "system", content: sistemaTexto + "\n[AVISO]: Imagem em processamento no Filtro 1." }, ...historicoSanitizado];

      [chamadaFiltro1, chamadaFiltro2, chamadaFiltro3] = await Promise.all([
        nvidia.chat.completions.create({ model: "meta/llama-3.2-11b-vision-instruct", messages: promptVisaoPuro }).catch(encapsularErroModulo("Llama-Vision")),
        nvidia.chat.completions.create({ model: "deepseek-ai/deepseek-v4-flash", messages: promptTextoCego }).catch(encapsularErroModulo("DeepSeek-Flash")),
        nvidia.chat.completions.create({ model: "meta/llama-3.1-8b-instruct", messages: promptTextoCego }).catch(encapsularErroModulo("Llama-8B"))
      ]);
    } else {
      [chamadaFiltro1, chamadaFiltro2, chamadaFiltro3] = await Promise.all([
        nvidia.chat.completions.create({ model: "deepseek-ai/deepseek-v4-flash", messages: promptTextualPuro }).catch(encapsularErroModulo("DeepSeek-Flash")),
        nvidia.chat.completions.create({ model: "meta/llama-3.1-8b-instruct", messages: promptTextualPuro }).catch(encapsularErroModulo("Llama-8B")),
        nvidia.chat.completions.create({ model: "meta/llama-3.1-70b-instruct", messages: promptTextualPuro }).catch(encapsularErroModulo("Llama-70B"))
      ]);
    }

    const txt1 = chamadaFiltro1.error ? chamadaFiltro1.message : (chamadaFiltro1.choices?.[0]?.message?.content || "Sem retorno.");
    const txt2 = chamadaFiltro2.error ? chamadaFiltro2.message : (chamadaFiltro2.choices?.[0]?.message?.content || "Sem retorno.");
    const txt3 = chamadaFiltro3.error ? chamadaFiltro3.message : (chamadaFiltro3.choices?.[0]?.message?.content || "Sem retorno.");

    // CONSOLIDAÇÃO VIA LLAma 3.3 70B JET ENGINE
    const promptJuiz = `Você é o Juiz do Cactus. Selecione a melhor resposta estruturada em PORTUGUÊS (PT-BR). Se houver dados de tempo real da internet ou tabelas locais, garanta que a opção escolhida os usou corretamente.\n\nPergunta: "${ultimaMensagem}"\n\nOpção 1: ${txt1}\n\nOpção 2: ${txt2}\n\nOpção 3: ${txt3}`;
    
    const chamadaJuiz = await nvidia.chat.completions.create({ model: "meta/llama-3.3-70b-instruct", messages: [{ role: "user", content: promptJuiz }] }).catch(() => null);
    const respostaVencedora = (chamadaJuiz && chamadaJuiz.choices?.[0]?.message?.content) ? chamadaJuiz.choices[0].message.content : txt1;

    // MONTAGEM DO LOG AUDITÁVEL DO BASTIDORES
    let logRAG = "";
    if (dadosCientificosLocais) logRAG += `[Ancoragem Zootécnica Ativa] `;
    logRAG += pesquisaWeb ? `[Web Dados]: ${dadosInternet.substring(0, 300)}...` : `[Pesquisa Web Inativa] No local data injected.`;

    res.json({
      respostaFinal: respostaVencedora,
      auditoria: { deepseek: txt1, gemma: txt2, llama8b: txt3, webRaw: logRAG }
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[Cactus Core] Barramento Web e Local consertado na porta ${PORT}`));
