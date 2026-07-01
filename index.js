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

// Conexão estável com a nova instância isolada do Supabase via variáveis de ambiente
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

function comprimirETrancarTexto(texto) {
  if (!texto) return "";
  let resultado = texto.replace(/\s+/g, ' ').trim();
  if (resultado.length > 15000) {
    resultado = resultado.substring(0, 15000) + "\n\n[AVISO: CONTEÚDO TRUNCADO PELO SERVIDOR EM 15K CARACTERES FORÇANDO JANELA DE CONTEXTO]";
  }
  return resultado;
}

// 📁 ROTAS DE GERENCIAMENTO DE ESTADO RELACIONAL (SUPABASE SYNC)

// A. Listar todos os chats salvos no banco
app.get('/api/chats', async (req, res) => {
  const { data, error } = await supabase.from('chats').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  return res.json(data);
});

// B. Criar uma nova sessão física de chat com UUID estável
app.post('/api/chats', async (req, res) => {
  const { title } = req.body;
  const { data, error } = await supabase.from('chats').insert({ title: title || 'Novo Chat' }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  return res.json(data);
});

// C. Deletar chat e todas as suas mensagens em cascata
app.delete('/api/chats/:id', async (req, res) => {
  const { error } = await supabase.from('chats').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ success: true });
});

// D. Resgatar histórico real de mensagens para renderização no front-end
app.get('/api/chats/:id/mensagens', async (req, res) => {
  const { data, error } = await supabase.from('messages').select('role, content, auditoria').eq('chat_id', req.params.id).order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  return res.json(data);
});

// 🔬 PIPELINE PRINCIPAL DE INFERÊNCIA PARALELA
app.post('/api/perguntar', async (req, res) => {
  let respostaFinalConsolidada = "Erro: Nenhuma IA respondeu a tempo.";
  let logRAG = "";
  let txt1 = "N/A", txt2 = "N/A", txt3 = "N/A";
  let flagDocumentoAtivo = false;
  let logDocNome = "";

  const { chatId, ultimaMensagem, customInstructions, memoryContext, pesquisaWeb, arquivoAnexo } = req.body;

  if (!chatId) return res.status(400).json({ error: 'Identificador do chat (chatId) obrigatório.' });

  try {
    let sistemaTexto = "Seu nome é Cactus. Responda em português de forma profunda, exata e científica.";
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
        
        // Atualiza o título do chat no banco com o nome do documento enviado
        await supabase.from('chats').update({ title: arquivoAnexo.nome }).eq('id', chatId);
        
        // Persiste o documento isoladamente no banco relacional
        await supabase.from('chat_documents').insert({
          chat_id: chatId, file_name: arquivoAnexo.nome, extracted_text: textoFinalDoc
        });
      } catch (errParser) {
        console.error("Falha no parser:", errParser.message);
      }
    }

    // Resgate de Contexto Imune a Amnésia: O servidor reconecta o arquivo automaticamente em todas as próximas mensagens
    const { data: docs } = await supabase.from('chat_documents').select('file_name, extracted_text').eq('chat_id', chatId);
    if (docs && docs.length > 0) {
      docs.forEach(d => {
        sistemaTexto += `\n\n[CONTEÚDO DO DOCUMENTO PERSISTIDO NO NOVO SUPABASE (${d.file_name})]:\n${d.extracted_text}`;
      });
    }

    const { data: historicoBanco } = await supabase.from('messages').select('role, content').eq('chat_id', chatId).order('created_at', { ascending: true });
    const promptTextualPuro = [{ role: "system", content: sistemaTexto }, ...(historicoBanco || []), { role: "user", content: ultimaMensagem }];

    const [chamadaFiltro1, chamadaFiltro2, chamadaFiltro3] = await Promise.all([
      nvidia.chat.completions.create({ model: "deepseek-ai/deepseek-v4-flash", messages: promptTextualPuro }).catch(tratarErroPromessa("DeepSeek")),
      nvidia.chat.completions.create({ model: "meta/llama-3.1-8b-instruct", messages: promptTextualPuro }).catch(tratarErroPromessa("Llama-8B")),
      nvidia.chat.completions.create({ model: "meta/llama-3.3-70b-instruct", messages: promptTextualPuro }).catch(tratarErroPromessa("Llama-70B"))
    ]);

    txt1 = chamadaFiltro1.error ? chamadaFiltro1.message : chamadaFiltro1.choices[0].message.content;
    txt2 = chamadaFiltro2.error ? chamadaFiltro2.message : chamadaFiltro2.choices[0].message.content;
    txt3 = chamadaFiltro3.error ? chamadaFiltro3.message : chamadaFiltro3.choices[0].message.content;

    const promptJuiz = `Retorne APENAS a melhor resposta.\nPergunta: "${ultimaMensagem}"\nOpção 1: ${txt1}\nOpção 2: ${txt2}\nOpção 3: ${txt3}`;
    const chamadaJuiz = await nvidia.chat.completions.create({ model: "meta/llama-3.3-70b-instruct", messages: [{ role: "user", content: promptJuiz }], max_tokens: 1000 }).catch(() => null);

    if (chamadaJuiz && llamadaJuiz.choices?.[0]?.message?.content) {
      respostaFinalConsolidada = chamadaJuiz.choices[0].message.content;
    } else {
      respostaFinalConsolidada = !chamadaFiltro2.error ? txt2 : (!chamadaFiltro1.error ? txt1 : txt3);
    }

    // Insere de forma permanente o novo turno no banco isolado
    await supabase.from('messages').insert([
      { chat_id: chatId, role: 'user', content: ultimaMensagem },
      { chat_id: chatId, role: 'assistant', content: respostaFinalConsolidada }
    ]);

    logRAG = `[Supabase Isolado Ativo] Docs na sessão: ${docs ? docs.length : 0}`;

    return res.json({
      respostaFinal: respostaFinalConsolidada,
      auditoria: { deepseek: txt1, gemma: txt2, llama8b: txt3, webRaw: logRAG }
    });

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[Cactus Central] Operando com projeto isolado na porta ${PORT}`));