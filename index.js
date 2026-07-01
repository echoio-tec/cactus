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

// Conexão estável com o Supabase utilizando chaves de ambiente
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const nvidia = new OpenAI({ apiKey: process.env.NVIDIA_API_KEY, baseURL: 'https://integrate.api.nvidia.com/v1', timeout: 15000 });

function tratarErroPromessa(modelo) {
  return (err) => ({ error: true, message: `Módulo ${modelo} offline: ${err.message}` });
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

function comprimirETrancarTexto(texto) {
  if (!texto) return "";
  let resultado = texto.replace(/\s+/g, ' ').trim();
  if (resultado.length > 15000) {
    resultado = resultado.substring(0, 15000) + "\n\n[AVISO: CONTEÚDO TRUNCADO PELO SERVIDOR EM 15K CARACTERES FORÇANDO JANELA DE CONTEXTO]";
  }
  return resultado;
}

function verificarMensagemTrivial(texto) {
  const t = texto.toLowerCase().trim();
  if (!t) return true;

  const termosTriviais = [
    'oi', 'ola', 'olá', 'tudo bem', 'tudo bom', 'bom dia', 'boa tarde', 'boa noite', 
    'obrigado', 'obrigada', 'valeu', 'show', 'ok', 'blz', 'beleza', 'tchau', 'vlw', 
    'entendi', 'perfeito', 'top', 'sim', 'nao', 'não', 'ajuda'
  ];

  const totalPalavras = t.split(' ').length;
  if (totalPalavras <= 2) return true;

  return termosTriviais.some(termo => t === termo || t.startsWith(termo + ' '));
}

async function buscarNaWeb(query) {
  try {
    if (!process.env.TAVILY_API_KEY) return "Aviso: Chave da Tavily ausente.";
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: process.env.TAVILY_API_KEY, query: query, search_depth: "basic", max_results: 3 })
    });
    if (!response.ok) return "Sem resultados relevantes da busca externa.";
    const data = await response.json();
    return data.results ? data.results.map(r => `Título: ${r.title}\nConteúdo: ${r.content}`).join('\n\n') : "Nenhum resultado encontrado.";
  } catch (err) {
    return `Falha na conexão com Tavily: ${err.message}`;
  }
}

// ROTAS DE GERENCIAMENTO DE SESSÕES NO SUPABASE
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

// ROUTER PRINCIPAL DE PROCESSAMENTO
app.post('/api/perguntar', async (req, res) => {
  let respostaFinalConsolidada = "Erro: Sem resposta dos modelos.";
  let logRAG = "";
  let txt1 = "N/A", txt2 = "N/A", txt3 = "N/A";
  let flagDocumentoAtivo = false;
  let logDocNome = "";

  const { chatId, ultimaMensagem, customInstructions, memoryContext, pesquisaWeb, arquivoAnexo } = req.body;

  if (!chatId) return res.status(400).json({ error: 'chatId ausente.' });

  try {
    let sistemaTexto = "Seu nome é Cactus. Responda em português de forma profunda e científica.";
    if (memoryContext) sistemaTexto += `\n\n[MEMÓRIA]: ${memoryContext}`;
    if (customInstructions) sistemaTexto += `\n\n[DIRETRIZ]: ${customInstructions}`;

    if (arquivoAnexo && arquivoAnexo.tipo === 'documento' && arquivoAnexo.conteudo) {
      flagDocumentoAtivo = true;
      logDocNome = arquivoAnexo.nome;
      try {
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
        await supabase.from('chat_documents').insert({ chat_id: chatId, file_name: arquivoAnexo.nome, extracted_text: textoFinalDoc });
      } catch (errParser) {
        console.error(errParser.message);
      }
    }

    const { data: docs } = await supabase.from('chat_documents').select('file_name, extracted_text').eq('chat_id', chatId);
    if (docs && docs.length > 0) {
      docs.forEach(d => {
        sistemaTexto += `\n\n[CONTEÚDO DO DOCUMENTO PERSISTED (${d.file_name})]:\n${d.extracted_text}`;
      });
    }

    const { data: historicoBanco } = await supabase.from('messages').select('role, content').eq('chat_id', chatId).order('created_at', { ascending: true });
    const promptTextualPuro = [{ role: "system", content: sistemaTexto }, ...(historicoBanco || []), { role: "user", content: ultimaMensagem }];

    const ehMensagemTrivial = verificarMensagemTrivial(ultimaMensagem);
    if (ehMensagemTrivial && !arquivoAnexo && !pesquisaWeb) {
      const chamadaFastPath = await nvidia.chat.completions.create({
        model: "deepseek-ai/deepseek-v4-flash",
        messages: [{ role: "system", content: sistemaTexto + "\nResponda de forma curta em no máximo duas frases." }, ...promptTextualPuro.slice(1)],
        max_tokens: 120
      }).catch(tratarErroPromessa("DeepSeek-FastPath"));

      respostaFinalConsolidada = chamadaFastPath.error ? chamadaFastPath.message : chamadaFastPath.choices[0].message.content;
      
      await supabase.from('messages').insert([
        { chat_id: chatId, role: 'user', content: ultimaMensagem },
        { chat_id: chatId, role: 'assistant', content: respostaFinalConsolidada, auditoria: { deepseek: respostaFinalConsolidada, gemma: "Ignorado", llama8b: "Ignorado", webRaw: "Fast-Path Ativo" } }
      ]);

      return res.json({ respostaFinal: respostaFinalConsolidada, auditoria: { deepseek: respostaFinalConsolidada, gemma: "N/A", llama8b: "N/A", webRaw: "Fast-Path Ativo" } });
    }

    let dadosInternet = "Pesquisa Web: Inativa.";
    if (pesquisaWeb && !flagDocumentoAtivo) {
      dadosInternet = await buscarNaWeb(ultimaMensagem);
      sistemaTexto += `\n\n[DADOS DA INTERNET]:\n${dadosInternet}`;
    }

    const [chamadaFiltro1, chamadaFiltro2, chamadaFiltro3] = await Promise.all([
      nvidia.chat.completions.create({ model: "deepseek-ai/deepseek-v4-flash", messages: promptTextualPuro }).catch(tratarErroPromessa("DeepSeek")),
      nvidia.chat.completions.create({ model: "meta/llama-3.1-8b-instruct", messages: promptTextualPuro }).catch(tratarErroPromessa("Llama-8B")),
      nvidia.chat.completions.create({ model: "meta/llama-3.3-70b-instruct", messages: promptTextualPuro }).catch(tratarErroPromessa("Llama-70B"))
    ]);

    txt1 = chamadaFiltro1.error ? chamadaFiltro1.message : chamadaFiltro1.choices[0].message.content;
    txt2 = chamadaFiltro2.error ? chamadaFiltro2.message : chamadaFiltro2.choices[0].message.content; // CORREÇÃO EXATA DO TYPO: Alterado de llamadaFiltro2 para chamadaFiltro2
    txt3 = chamadaFiltro3.error ? chamadaFiltro3.message : chamadaFiltro3.choices[0].message.content;

    const promptJuiz = `Retorne APENAS a melhor resposta.\nPergunta: "${ultimaMensagem}"\nOpção 1: ${txt1}\nOpção 2: ${txt2}\nOpção 3: ${txt3}`;
    const chamadaJuiz = await nvidia.chat.completions.create({ model: "meta/llama-3.3-70b-instruct", messages: [{ role: "user", content: promptJuiz }], max_tokens: 1000 }).catch(() => null);

    if (chamadaJuiz && chamadaJuiz.choices?.[0]?.message?.content) {
      respostaFinalConsolidada = chamadaJuiz.choices[0].message.content;
    } else {
      respostaFinalConsolidada = !chamadaFiltro2.error ? txt2 : (!chamadaFiltro1.error ? txt1 : txt3);
    }

    logRAG = `[Supabase RAG] Docs: ${docs ? docs.length : 0} | Internet: ${pesquisaWeb ? "Sim" : "Não"}`;
    const objetoAuditoria = { deepseek: txt1, gemma: txt2, llama8b: txt3, webRaw: logRAG };

    // CORREÇÃO: Salvando o objeto de auditoria real no banco para evitar os logs em "N/A" ao recarregar a conversa
    await supabase.from('messages').insert([
      { chat_id: chatId, role: 'user', content: ultimaMensagem },
      { chat_id: chatId, role: 'assistant', content: respostaFinalConsolidada, auditoria: objetoAuditoria }
    ]);

    return res.json({ respostaFinal: respostaFinalConsolidada, auditoria: objetoAuditoria });

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[Cactus Central] Ativo na porta ${PORT}`));