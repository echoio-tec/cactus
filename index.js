const express = require('express');
const cors = require('cors');
const { OpenAI } = require('openai');
const { createClient } = require('@supabase/supabase-js');

// Módulos de extração de texto server-side
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const XLSX = require('xlsx');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const nvidia = new OpenAI({ apiKey: process.env.NVIDIA_API_KEY, baseURL: 'https://integrate.api.nvidia.com/v1', timeout: 15000 });

function tratarErroPromessa(modelo) {
  return (err) => ({ error: true, message: `Módulo ${modelo} indisponível: ${err.message}` });
}

// RESTRUTURAÇÃO LOGICA: Retorna o erro no catch interno para não quebrar o Promise.all do ringue analítico
const corridaTimeout = (promessa, ms, modelo) => Promise.race([
  promessa,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout de Latência no módulo ${modelo}`)), ms))
]).catch((err) => ({ error: true, message: err.message }));

const BASE_CONHECIMENTO_AGRO = {
  nutricao_aves: "Tabela Técnica (Embrapa/NRC): Frangos de corte na fase inicial (1 a 21 dias) exigem: Energia Metabolizável: 2.950 a 3.000 kcal/kg. Proteína Bruta: 21% a 22%. Lisina Digestível: 1,22%. Metionina Digestível: 0,49%. Cálcio: 0,92%. Fósforo Disponível: 0,43%.",
  nutricao_bovinos: "Padrão de Confinamento Bovino: Relação volumoso:concentrado para terminação geralmente varia de 20:80 a 10:90. Exigência média de MS (Matéria Seca): 2,3% a 2,5% do Peso Vivo (PV). Ganho de peso esperado em dietas de alto grão: 1,4 kg a 1,8 kg/dia.",
  fertilidade_solo: "Recomendações de Fertilidade (Semiárido/Zinco): O nível crítico de Zinco (Zn) no solo pelo extrator Mehlich-1 é de 1,0 a 1,2 mg/dm³. Deficiências em plantas causam encurtamento de entrenós (rosetamento) and clorose listrada interveinal. Fontes: Sulfato de Zinco (20-22% Zn) ou Óxido de Zinco (50-80% Zn).",
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
      if (ultima.role === msg.role) ultima.content += `\n${msg.content}`; 
      else limpo.push({ role: msg.role, content: msg.content });
    }
  }
  return limpo;
}

function comprimirETrancarTexto(texto) {
  if (!texto) return "";
  let resultado = texto.replace(/\s+/g, ' ').trim();
  if (resultado.length > 15000) {
    resultado = resultado.substring(0, 15000) + "\n\n[AVISO: CONTEÚDO TRUNCADO PELO SERVIDOR]";
  }
  return resultado;
}

function verificarMensagemTrivial(texto) {
  const t = texto.toLowerCase().trim();
  if (!t) return true;
  const termosTriviais = ['oi', 'ola', 'olá', 'tudo bem', 'tudo bom', 'bom dia', 'boa tarde', 'boa noite', 'obrigado', 'obrigada', 'valeu', 'show', 'ok', 'blz', 'tchau', 'vlw', 'sim', 'nao', 'não', 'ajuda'];
  return t.split(' ').length <= 2 || termosTriviais.some(termo => t === termo || t.startsWith(termo + ' '));
}

async function buscarNaWeb(query) {
  try {
    if (!process.env.TAVILY_API_KEY) return "Aviso: Chave da Tavily ausente.";
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: process.env.TAVILY_API_KEY, query: query, search_depth: "basic", max_results: 3 })
    });
    const data = await response.json();
    return data.results ? data.results.map(r => `Título: ${r.title}\nConteúdo: ${r.content}`).join('\n\n') : "Nenhum resultado encontrado.";
  } catch (err) {
    return `Falha na conexão externa: ${err.message}`;
  }
}

// ROTAS DE CHATS
app.get('/api/chats', async (req, res) => {
  const { data, error } = await supabase.from('chats').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  return res.json(data);
});

app.post('/api/chats', async (req, res) => {
  const { title } = req.body;
  const { data, error } = await supabase.from('chats').insert({ title: title || 'Novo Chat' }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  return res.json(data);
});

app.delete('/api/chats/:id', async (req, res) => {
  const { error } = await supabase.from('chats').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ success: true });
});

app.get('/api/chats/:id/mensagens', async (req, res) => {
  const { data, error } = await supabase.from('messages').select('role, content, auditoria').eq('chat_id', req.params.id).order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  return res.json(data);
});

// ROUTER PRINCIPAL DE INFERÊNCIA
app.post('/api/perguntar', async (req, res) => {
  let respostaFinalConsolidada = "Erro: Sem resposta operacional.";
  let logRAG = "";
  let txt1 = "N/A", txt2 = "N/A", txt3 = "N/A";
  let flagDocumentoAtivo = false;
  let logDocNome = "";

  const { chatId, ultimaMensagem, customInstructions, memoryContext, pesquisaWeb, arquivoAnexo } = req.body;
  if (!chatId) return res.status(400).json({ error: 'chatId obrigatório.' });

  try {
    let sistemaTexto = "Seu nome é Cactus. Você é um assistente de inteligência artificial de elite, forte, prestativo e com rigor científico. Responda em português (PT-BR) de forma profunda, exata e analítica.";
    if (memoryContext) sistemaTexto += `\n\n[MEMÓRIA DO USUÁRIO]:\n${memoryContext}`;
    if (customInstructions) sistemaTexto += `\n\n[DIRETRIZ DE ESTILO]:\n${customInstructions}`;

    // CRUCIAL: O processamento e upload do arquivo ocorrem antes de disparar as IAs para impedir perdas por timeout
    if (arquivoAnexo && arquivoAnexo.tipo === 'documento' && arquivoAnexo.conteudo) {
      flagDocumentoAtivo = true;
      logDocNome = arquivoAnexo.nome;
      try {
        await supabase.from('chat_documents').delete().eq('chat_id', chatId);
        
        const partesBase64 = arquivoAnexo.conteudo.split(';base64,');
        const dadosBrutos = partesBase64[1] || partesBase64[0]; 
        const bufferArquivo = Buffer.from(dadosBrutos, 'base64');
        const nomeMinusculo = arquivoAnexo.nome.toLowerCase();
        let textoExtraido = "";

        if (nomeMinusculo.endsWith('.pdf')) {
          const parsedPdf = await pdfParse(bufferArquivo); textoExtraido = parsedPdf.text;
        } else if (nomeMinusculo.endsWith('.docx')) {
          const parsedWord = await mammoth.extractRawText({ buffer: bufferArquivo }); textoExtraido = parsedWord.value;
        } else if (nomeMinusculo.endsWith('.xlsx')) {
          const workbook = XLSX.read(bufferArquivo, { type: 'buffer' });
          workbook.SheetNames.forEach(s => { textoExtraido += XLSX.utils.sheet_to_csv(workbook.Sheets[s]); });
        }

        const textoFinalDoc = comprimirETrancarTexto(textoExtraido);
        
        await supabase.from('chats').update({ title: arquivoAnexo.nome }).eq('id', chatId);
        const { error: errorDoc } = await supabase.from('chat_documents').insert({ chat_id: chatId, file_name: arquivoAnexo.nome, extracted_text: textoFinalDoc });
        if (errorDoc) console.error("Erro Supabase Document: ", errorDoc.message);
      } catch (errParser) {
        console.error("Erro de Parsing Interno: ", errParser.message);
      }
    }

    // Resgata o documento persistido de forma assíncrona garantida
    const { data: docs } = await supabase.from('chat_documents').select('file_name, extracted_text').eq('chat_id', chatId);
    let conteudoDoDocumentoTexto = "";
    if (docs && docs.length > 0) {
      docs.forEach(d => {
        conteudoDoDocumentoTexto += d.extracted_text;
        sistemaTexto += `\n\n[CONTEÚDO DO DOCUMENTO ANEXADO EM ANÁLISE]:\n${d.extracted_text}`;
      });
    }

    const { data: historicoBanco } = await supabase.from('messages').select('role, content').eq('chat_id', chatId).order('created_at', { ascending: true });
    const promptTextualPuro = [{ role: "system", content: sistemaTexto }, ...(historicoBanco || []), { role: "user", content: ultimaMensagem }];

    const textoMinusculo = ultimaMensagem.toLowerCase().trim();
    const ehPromptGrafico = textoMinusculo.startsWith('/gerar') || textoMinusculo.startsWith('/imagem') || 
                            textoMinusculo.startsWith('gerar uma imagem') || textoMinusculo.startsWith('gerar imagem') ||
                            textoMinusculo.startsWith('gere uma imagem') || textoMinusculo.startsWith('gere imagem') ||
                            textoMinusculo.startsWith('desenhe') || textoMinusculo.startsWith('crie uma imagem') || 
                            textoMinusculo.startsWith('crie imagem');

    if (ehPromptGrafico) {
      let promptImagem = ultimaMensagem
        .replace(/^\/(gerar|imagem)\s*/i, '')
        .replace(/^(gerar uma imagem|gerar imagem|gere uma imagem|gere imagem|desenhe|crie uma imagem de|crie uma imagem|crie imagem)\s*/i, '')
        .trim();

      // BLINDAGEM DE IMAGEM: Injeta o resumo do documento técnico no prompt do SDXL para evitar delírios visuais
      if (conteudoDoDocumentoTexto) {
        promptImagem += ` em harmonia com o seguinte contexto técnico: ${conteudoDoDocumentoTexto.substring(0, 500)}`;
      }

      try {
        const responseImg = await nvidia.images.generate({ model: "stabilityai/stable-diffusion-xl", prompt: promptImagem });
        respostaFinalConsolidada = `🎨 Aqui está a imagem gerada para **"${promptImagem.split(' em harmonia')[0]}"**:\n\n![Imagem Gerada](${responseImg.data[0].url})`;
      } catch (errImg) {
        const urlReserva = `https://image.pollinations.ai/p/${encodeURIComponent(promptImagem)}?width=1024&height=1024&seed=${Date.now()}&enhance=true`;
        respostaFinalConsolidada = `🎨 Aqui está a imagem gerada para **"${promptImagem.split(' em harmonia')[0]}"**:\n\n![Imagem Gerada](${urlReserva})`;
      }

      const auditGrafica = { deepseek: "SDXL Active", gemma: "N/A", llama8b: "N/A", webRaw: "Pipeline Gráfico" };
      await supabase.from('messages').insert([
        { chat_id: chatId, role: 'user', content: ultimaMensagem },
        { chat_id: chatId, role: 'assistant', content: respostaFinalConsolidada, auditoria: auditGrafica }
      ]);

      const { data: chatAtual } = await supabase.from('chats').select('title').eq('id', chatId).single();
      if (chatAtual && chatAtual.title === 'Novo Chat') {
        await supabase.from('chats').update({ title: promptImagem.substring(0, 25) }).eq('id', chatId);
      }

      return res.json({ respostaFinal: respostaFinalConsolidada, auditoria: auditGrafica });
    }

    const ehMensagemTrivial = verificarMensagemTrivial(ultimaMensagem);
    if (ehMensagemTrivial && !arquivoAnexo && !pesquisaWeb) {
      const chamadaFastPath = await nvidia.chat.completions.create({
        model: "deepseek-ai/deepseek-v4-flash",
        messages: [{ role: "system", content: sistemaTexto + "\nResponda de forma curta em no máximo duas frases." }, ...promptTextualPuro.slice(1)],
        max_tokens: 120
      }).catch(tratarErroPromessa("FastPath"));

      respostaFinalConsolidada = chamadaFastPath.error ? chamadaFastPath.message : chamadaFastPath.choices[0].message.content;
      
      const auditTrivial = { deepseek: respostaFinalConsolidada, gemma: "N/A", llama8b: "N/A", webRaw: "Fast-Path Ativo" };
      await supabase.from('messages').insert([
        { chat_id: chatId, role: 'user', content: ultimaMensagem },
        { chat_id: chatId, role: 'assistant', content: respostaFinalConsolidada, auditoria: auditTrivial }
      ]);
      return res.json({ respostaFinal: respostaFinalConsolidada, auditoria: auditTrivial });
    }

    if (pesquisaWeb && !flagDocumentoAtivo) {
      dadosInternet = await buscarNaWeb(ultimaMensagem);
      sistemaTexto += `\n\n[DADOS INTERNET]:\n${dadosInternet}`;
    }

    const [chamadaFiltro1, chamadaFiltro2, chamadaFiltro3] = await Promise.all([
      corridaTimeout(nvidia.chat.completions.create({ model: "deepseek-ai/deepseek-v4-flash", messages: promptTextualPuro }), 4500).catch(tratarErroPromessa("DeepSeek")),
      corridaTimeout(nvidia.chat.completions.create({ model: "meta/llama-3.1-8b-instruct", messages: promptTextualPuro }), 4500).catch(tratarErroPromessa("Llama-8B")),
      corridaTimeout(nvidia.chat.completions.create({ model: "meta/llama-3.3-70b-instruct", messages: promptTextualPuro }), 5500).catch(tratarErroPromessa("Llama-70B"))
    ]);

    txt1 = chamadaFiltro1.error ? chamadaFiltro1.message : chamadaFiltro1.choices[0].message.content;
    txt2 = chamadaFiltro2.error ? chamadaFiltro2.message : chamadaFiltro2.choices[0].message.content;
    txt3 = chamadaFiltro3.error ? chamadaFiltro3.message : chamadaFiltro3.choices[0].message.content;

    const promptJuiz = `Determine a melhor resposta estruturada em português baseado estritamente no contexto fornecido.\nPergunta: "${ultimaMensagem}"\nOpção 1: ${txt1}\nOpção 2: ${txt2}\nOpção 3: ${txt3}`;
    const chamadaJuiz = await corridaTimeout(nvidia.chat.completions.create({ model: "meta/llama-3.3-70b-instruct", messages: [{ role: "user", content: promptJuiz }], max_tokens: 1000 }), 4000).catch(() => null);

    if (chamadaJuiz && chamadaJuiz.choices?.[0]?.message?.content) {
      respostaFinalConsolidada = chamadaJuiz.choices[0].message.content;
    } else {
      respostaFinalConsolidada = !chamadaFiltro2.error ? txt2 : (!chamadaFiltro1.error ? txt1 : txt3);
    }

    logRAG = `[Supabase] Docs Ativos: ${docs ? docs.length : 0}`;
    const objetoAuditoria = { deepseek: txt1, gemma: txt2, llama8b: txt3, webRaw: logRAG };

    await supabase.from('messages').insert([
      { chat_id: chatId, role: 'user', content: ultimaMensagem },
      { chat_id: chatId, role: 'assistant', content: respostaFinalConsolidada, auditoria: objetoAuditoria }
    ]);

    const { data: chatAtual } = await supabase.from('chats').select('title').eq('id', chatId).single();
    if (chatAtual && chatAtual.title === 'Novo Chat') {
      const novoTitulo = flagDocumentoAtivo ? logDocNome : (ultimaMensagem.length > 25 ? ultimaMensagem.substring(0, 25) + '...' : ultimaMensagem);
      await supabase.from('chats').update({ title: novoTitulo }).eq('id', chatId);
    }

    return res.json({ respostaFinal: respostaFinalConsolidada, auditoria: objetoAuditoria });

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[Cactus Central] Operando na porta ${PORT}`));